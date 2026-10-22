#!/usr/bin/env python3
"""Minimal agent harness loop for any OpenAI-compatible chat completions API.

Works with OpenAI, Azure OpenAI, DeepSeek, OpenRouter, Together, Groq,
Ollama, LM Studio, vLLM, llama.cpp, and anything else implementing the
OpenAI `/chat/completions` spec (including function/tool calling).

Usage:
    export OPENAI_API_KEY=sk-...                  # optional for local servers
    export OPENAI_BASE_URL=https://api.vikey.ai/v1/chat/completions
    export OPENAI_MODEL=gpt-4o-mini
    python3 agent.py "What is 12 * 34 plus 5?"

Examples for other providers:
    export OPENAI_BASE_URL=https://api.deepseek.com
    export OPENAI_MODEL=deepseek-chat

    export OPENAI_BASE_URL=http://localhost:11434/v1   # Ollama
    export OPENAI_MODEL=llama3.1

No third-party dependencies — uses only the standard library.

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

SYSTEM_PROMPT = (
    "You are a helpful assistant. Use the provided tools when needed, "
    "otherwise answer directly."
)

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
    }
]

TOOL_IMPL = {"calculator": tool_calculator}


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

def run(user_input: str) -> str:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_input},
    ]

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


def main():
    if len(sys.argv) < 2:
        sys.exit('Usage: python3 agent.py "your question"')

    try:
        answer = run(" ".join(sys.argv[1:]))
    except RuntimeError as exc:
        sys.exit(str(exc))
    print(answer)


if __name__ == "__main__":
    main()
