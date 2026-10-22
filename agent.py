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

Tools: `calculator` and `read` (text files and directory listings). The read
tool is confined to the working directory; set AGENT_READ_ROOT to allow a
different directory, and AGENT_MAX_READ_LINES / AGENT_MAX_READ_BYTES to tune
how much a single read returns.

Settings are read from `.env` next to this script (see `.env.example`),
then from the process environment, which takes precedence.
"""

import json
import os
import sys
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
    "You are a helpful assistant. Use the provided tools when needed "
    "(for example, read a file before answering questions about it), "
    "otherwise answer directly."
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


def read_root() -> Path:
    """Directory the read tool is allowed to touch."""
    configured = os.environ.get("AGENT_READ_ROOT")
    return Path(configured).expanduser().resolve() if configured else Path.cwd().resolve()


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

    root = read_root()
    target = Path(path).expanduser()
    if not target.is_absolute():
        target = root / target
    resolved = target.resolve()

    # Refuse anything that escapes the root, including via symlinks.
    if resolved != root and root not in resolved.parents:
        return f"Error: '{path}' is outside the allowed root ({root})."
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
]

TOOL_IMPL = {"calculator": tool_calculator, "read": tool_read}


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
