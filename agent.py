#!/usr/bin/env python3
"""Minimal agent harness loop for any OpenAI-compatible chat completions API.

Works with OpenAI, Azure OpenAI, DeepSeek, OpenRouter, Together, Groq,
Ollama, LM Studio, vLLM, llama.cpp, and anything else implementing the
OpenAI `/chat/completions` spec (including function/tool calling).

Usage:
    export OPENAI_API_KEY=sk-...                  # optional for local servers
    export OPENAI_BASE_URL=https://api.vikey.ai/v1/chat/completions
    export OPENAI_MODEL=gpt-4o-mini

    python3 agent.py "What is 12 * 34 plus 5?"    # single question
    python3 agent.py                             # interactive multi-turn chat

In interactive mode the whole conversation (including tool calls and their
results) is kept, so follow-ups like "and multiply that by 2" work. Commands:
    /help    show help
    /reset   clear the conversation history
    /exit    quit (or press Ctrl-D)

Examples for other providers:
    export OPENAI_BASE_URL=https://api.deepseek.com
    export OPENAI_MODEL=deepseek-chat

    export OPENAI_BASE_URL=http://localhost:11434/v1   # Ollama
    export OPENAI_MODEL=llama3.1

No third-party dependencies — uses only the standard library.

Tools: `calculator`, `read` (text files and directory listings), `write`
(create/overwrite a file) and `edit` (exact-string replacement). File tools
are confined to the working directory; set AGENT_ROOT to allow a different
directory, and AGENT_MAX_READ_LINES / AGENT_MAX_READ_BYTES to tune how much a
single read returns (the byte limit also caps the size of an edited file).

Settings are read from `.env` next to this script (see `.env.example`),
then from the process environment, which takes precedence.
"""

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


def load_dotenv(path=None):
    """Load KEY=VALUE pairs from a .env file without overriding real env vars."""
    if path is None:
        path = Path(__file__).with_name(".env")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


load_dotenv()

API_KEY = os.environ.get("OPENAI_API_KEY") or os.environ.get("LLM_API_KEY")
BASE_URL = (
    os.environ.get("OPENAI_BASE_URL")
    or os.environ.get("LLM_BASE_URL")
    or "https://api.vikey.ai/v1/chat/completions"
)
MODEL = (
    os.environ.get("OPENAI_MODEL")
    or os.environ.get("LLM_MODEL")
    or "gpt-4o-mini"
)
MAX_TURNS = int(os.environ.get("AGENT_MAX_TURNS", "8"))
TIMEOUT = float(os.environ.get("OPENAI_TIMEOUT", "60"))
MAX_READ_LINES = int(os.environ.get("AGENT_MAX_READ_LINES", "2000"))
MAX_READ_BYTES = int(os.environ.get("AGENT_MAX_READ_BYTES", "1000000"))

SYSTEM_PROMPT = (
    "You are a helpful assistant. Use the provided tools when needed. "
    "Read a file before answering questions about it, and read before "
    "editing; prefer 'edit' over 'write' for changes to existing files. "
    "Otherwise answer directly."
)

HELP_TEXT = """\
Commands:
  /help    show this help
  /reset   clear the conversation history
  /exit    quit (or press Ctrl-D)

Anything else is sent to the model as your next message."""

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

def tool_calculator(expression: str) -> str:
    """Evaluate a safe arithmetic expression and return the result."""
    try:
        # Only allow digits, operators, parentheses and whitespace.
        if not all(c in "0123456789+-*/(). %" for c in expression):
            return "Error: expression contains disallowed characters."
        value = eval(expression, {"__builtins__": {}}, {})  # noqa: S307 (whitelisted)
        return str(value)
    except Exception as exc:  # noqa: BLE001
        return f"Error: {exc}"


def workspace_root() -> Path:
    """Directory the file tools are allowed to touch."""
    configured = os.environ.get("AGENT_ROOT") or os.environ.get("AGENT_READ_ROOT")
    return Path(configured).expanduser().resolve() if configured else Path.cwd().resolve()


def resolve_in_root(path: str):
    """Resolve a user/model supplied path inside the workspace root.

    Returns (resolved_path, error_message). Paths may be relative (to the root)
    or absolute, but must stay inside the root once symlinks are resolved.
    """
    if not isinstance(path, str) or not path.strip():
        return None, "Error: path must be a non-empty string."

    root = workspace_root()
    target = Path(path).expanduser()
    if not target.is_absolute():
        target = root / target
    resolved = target.resolve()

    if resolved != root and root not in resolved.parents:
        return None, f"Error: '{path}' is outside the allowed root ({root})."
    return resolved, None


def tool_read(path: str, offset: int = 1, limit=None) -> str:
    """Read a UTF-8 text file (or list a directory) under the allowed root."""
    try:
        offset = int(offset)
        limit = MAX_READ_LINES if limit is None else int(limit)
    except (TypeError, ValueError):
        return "Error: offset and limit must be integers."
    if offset < 1:
        return "Error: offset must be 1 or greater."
    if limit < 1:
        return "Error: limit must be 1 or greater."

    resolved, error = resolve_in_root(path)
    if error:
        return error
    if not resolved.exists():
        return f"Error: no such file or directory: {path}"

    if resolved.is_dir():
        entries = sorted(
            entry.name + ("/" if entry.is_dir() else "")
            for entry in resolved.iterdir()
        )
        if not entries:
            return "(empty directory)"
        if len(entries) > limit:
            extra = len(entries) - limit
            entries = entries[:limit] + [f"... ({extra} more entries)"]
        return "\n".join(entries)

    if not resolved.is_file():
        return f"Error: not a regular file: {path}"

    with resolved.open("rb") as fh:
        if b"\x00" in fh.read(4096):
            return f"Error: '{path}' looks like a binary file; only text is supported."
        fh.seek(0)

        # Skip to the requested line without loading the whole file.
        for _ in range(offset - 1):
            if not fh.readline():
                return f"Error: offset {offset} is past the end of the file."

        collected = []
        size = 0
        truncated = False
        while len(collected) < limit:
            line = fh.readline()
            if not line:
                break
            size += len(line)
            if size > MAX_READ_BYTES:
                truncated = True
                break
            collected.append(line)

        has_more = not truncated and bool(fh.readline())

    if not collected:
        return "(empty file)"

    lines = b"".join(collected).decode("utf-8", errors="replace").splitlines()
    out = [f"{offset + i}: {line}" for i, line in enumerate(lines)]
    if truncated:
        out.append(f"... (read limit of {MAX_READ_BYTES} bytes reached)")
    elif has_more:
        out.append(f"... (more lines; use offset={offset + len(lines)})")
    return "\n".join(out)


def _atomic_write(target: Path, text: str) -> None:
    """Write text through a temp file so a failure can't truncate the original."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(target.parent), prefix=f".{target.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        if target.exists():
            os.chmod(tmp, target.stat().st_mode & 0o777)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def tool_write(path: str, content: str) -> str:
    """Create a new UTF-8 text file, or overwrite an existing one."""
    if not isinstance(content, str):
        return "Error: content must be a string."

    resolved, error = resolve_in_root(path)
    if error:
        return error
    if resolved.exists() and resolved.is_dir():
        return f"Error: '{path}' is a directory."

    existed = resolved.exists()
    try:
        _atomic_write(resolved, content)
    except OSError as exc:
        return f"Error: could not write '{path}': {exc}"

    lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
    action = "Overwrote" if existed else "Created"
    return f"{action} {path} ({len(content)} bytes, {lines} line(s))."


def tool_edit(path: str, old_string: str, new_string: str, replace_all=False) -> str:
    """Replace exact text in an existing UTF-8 file."""
    if not isinstance(old_string, str) or not isinstance(new_string, str):
        return "Error: old_string and new_string must be strings."
    if not old_string:
        return "Error: old_string must not be empty."
    if old_string == new_string:
        return "Error: old_string and new_string are identical; nothing to do."
    if isinstance(replace_all, str):
        replace_all = replace_all.strip().lower() in ("1", "true", "yes")
    replace_all = bool(replace_all)

    resolved, error = resolve_in_root(path)
    if error:
        return error
    if not resolved.exists():
        return f"Error: no such file: {path}"
    if not resolved.is_file():
        return f"Error: not a regular file: {path}"
    if resolved.stat().st_size > MAX_READ_BYTES:
        return (
            f"Error: '{path}' is larger than the edit limit "
            f"({MAX_READ_BYTES} bytes)."
        )

    try:
        with resolved.open("r", encoding="utf-8", newline="") as fh:
            text = fh.read()
    except UnicodeDecodeError:
        return f"Error: '{path}' is not valid UTF-8 text."
    except OSError as exc:
        return f"Error: could not read '{path}': {exc}"

    # Match CRLF files even when the model supplies LF-only snippets.
    if "\r\n" in text and "\r\n" not in old_string:
        old_crlf = old_string.replace("\r\n", "\n").replace("\n", "\r\n")
        new_crlf = new_string.replace("\r\n", "\n").replace("\n", "\r\n")
        if old_crlf in text:
            old_string, new_string = old_crlf, new_crlf

    count = text.count(old_string)
    if count == 0:
        return f"Error: old_string not found in '{path}'."
    if count > 1 and not replace_all:
        return (
            f"Error: old_string appears {count} times in '{path}'; add more "
            "context to make it unique, or pass replace_all=true."
        )

    if replace_all:
        updated = text.replace(old_string, new_string)
    else:
        updated = text.replace(old_string, new_string, 1)

    try:
        _atomic_write(resolved, updated)
    except OSError as exc:
        return f"Error: could not write '{path}': {exc}"

    replaced = count if replace_all else 1
    return f"Edited {path}: replaced {replaced} occurrence(s)."


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "Evaluate a safe arithmetic expression.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Arithmetic expression, e.g. '12 * 34 + 5'.",
                    }
                },
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": (
                "Read a UTF-8 text file from disk, or list a directory. "
                "Returns numbered lines. Paths are relative to the working "
                "directory and must stay inside the allowed root."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File or directory path, e.g. 'agent.py'.",
                    },
                    "offset": {
                        "type": "integer",
                        "description": "1-based line number to start reading from (default 1).",
                    },
                    "limit": {
                        "type": "integer",
                        "description": (
                            f"Maximum number of lines to return (default {MAX_READ_LINES})."
                        ),
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write",
            "description": (
                "Create a new UTF-8 text file, or overwrite an existing one "
                "completely. Prefer 'edit' for changes to existing files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path, e.g. 'notes/todo.md'.",
                    },
                    "content": {
                        "type": "string",
                        "description": "Full file content to write.",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit",
            "description": (
                "Replace exact text in an existing file. Read the file first "
                "and include enough surrounding context for a unique match."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path, e.g. 'agent.py'.",
                    },
                    "old_string": {
                        "type": "string",
                        "description": "Exact text to replace, including indentation.",
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Replacement text.",
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every match instead of requiring a unique one.",
                    },
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
]

TOOL_IMPL = {
    "calculator": tool_calculator,
    "read": tool_read,
    "write": tool_write,
    "edit": tool_edit,
}


# ---------------------------------------------------------------------------
# OpenAI-compatible client (raw HTTP, no dependencies)
# ---------------------------------------------------------------------------

def chat_completions_url() -> str:
    """Build the chat completions URL from the configured base URL."""
    base = BASE_URL.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def chat(messages, tools=None):
    """Call the configured OpenAI-compatible chat completions endpoint."""
    payload = {"model": MODEL, "messages": messages}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"

    req = urllib.request.Request(
        chat_completions_url(),
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(
            f"LLM API error {exc.code} from {chat_completions_url()}: {body}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Could not reach {chat_completions_url()}: {exc.reason}"
        ) from exc


def message_text(message) -> str:
    """Extract plain text from a message, tolerating content-part arrays."""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts)
    return ""


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

class Conversation:
    """A chat history that can be continued across multiple user turns."""

    def __init__(self, system_prompt: str = SYSTEM_PROMPT):
        self.messages = [{"role": "system", "content": system_prompt}]

    def reset(self):
        """Drop everything except the system prompt."""
        self.messages = self.messages[:1]

    def send(self, user_input: str) -> str:
        """Append a user message, run the agent loop, and return the reply."""
        start = len(self.messages)
        self.messages.append({"role": "user", "content": user_input})
        try:
            return run_turn(self.messages)
        except Exception:
            # Don't leave a dangling user message behind if the call failed.
            del self.messages[start:]
            raise


def run_turn(messages):
    """Run the agent loop on `messages` until a final answer is produced.

    The conversation is mutated in place, so callers can keep appending to it.
    """
    for _ in range(MAX_TURNS):
        response = chat(messages, tools=TOOLS)
        choices = response.get("choices") or []
        if not choices:
            raise RuntimeError(f"LLM returned no choices: {response}")

        choice = choices[0]
        message = choice.get("message") or {}
        messages.append(message)

        # No tool call → final answer.
        if not message.get("tool_calls"):
            text = message_text(message)
            if text:
                return text
            reason = choice.get("finish_reason")
            return f"(no text; finish_reason={reason})" if reason else "(no text)"

        # Execute each tool call and append results.
        for call in message["tool_calls"]:
            function = call.get("function") or {}
            name = function.get("name", "")
            raw_args = function.get("arguments") or "{}"
            impl = TOOL_IMPL.get(name)

            if impl is None:
                result = f"Error: unknown tool '{name}'"
            else:
                try:
                    args = json.loads(raw_args)
                except json.JSONDecodeError as exc:
                    result = f"Error: invalid tool arguments: {exc}"
                else:
                    if not isinstance(args, dict):
                        result = "Error: tool arguments must be a JSON object."
                    else:
                        try:
                            result = impl(**args)
                        except TypeError as exc:
                            result = f"Error: {exc}"

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.get("id", ""),
                    "content": result,
                }
            )

    return "(stopped: max turns reached)"


def run(user_input: str) -> str:
    """Single-shot helper: one question, one answer."""
    return Conversation().send(user_input)


def repl(conversation=None):
    """Interactive chat loop that keeps context between messages."""
    conversation = conversation or Conversation()
    print("Interactive chat — type /help for commands, /exit to quit.")

    while True:
        try:
            line = input("you> ").strip()
        except EOFError:
            print()
            break
        except KeyboardInterrupt:
            print("\n(interrupted — /exit to quit)")
            continue

        if not line:
            continue

        command = line.lower()
        if command in ("/exit", "/quit"):
            break
        if command == "/help":
            print(HELP_TEXT)
            continue
        if command == "/reset":
            conversation.reset()
            print("(conversation cleared)")
            continue

        try:
            answer = conversation.send(line)
        except RuntimeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            continue

        print(f"\nassistant> {answer}")


def main():
    if len(sys.argv) > 1:
        try:
            answer = run(" ".join(sys.argv[1:]))
        except RuntimeError as exc:
            sys.exit(str(exc))
        print(answer)
        return

    repl()


if __name__ == "__main__":
    main()
