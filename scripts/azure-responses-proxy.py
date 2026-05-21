import json
import os
import sys
import time
import traceback
import uuid
from http.client import RemoteDisconnected
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
from requests.exceptions import ChunkedEncodingError, ConnectionError, ReadTimeout, Timeout


SCRIPT_DIR = os.path.dirname(__file__)
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
CONFIG_PATH = os.environ.get(
    "AZURE_RESPONSES_PROXY_CONFIG",
    os.path.join(SCRIPT_DIR, "azure-responses-proxy.config.json"),
)
LOG_PATH = os.environ.get(
    "AZURE_RESPONSES_PROXY_LOG",
    os.path.join(PROJECT_ROOT, "logs", "azure-responses-proxy.log"),
)


def _load_proxy_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as config_file:
            return json.load(config_file)
    except (OSError, ValueError):
        return {}


PROXY_CONFIG = _load_proxy_config()
DEFAULT_AZURE_OPENAI_BASE_URL = "https://genisom-cloud-code.openai.azure.com/openai/v1"


def _responses_url_from_base_url(base_url):
    return f"{str(base_url).strip().rstrip('/')}/responses"


def _load_upstreams():
    configured = PROXY_CONFIG.get("upstreams") or {}
    upstreams = {}
    for upstream_id, upstream_config in configured.items():
        model = str(upstream_config.get("model") or upstream_id).strip()
        responses_url = str(
            upstream_config.get("responses_url")
            or _responses_url_from_base_url(upstream_config.get("base_url") or DEFAULT_AZURE_OPENAI_BASE_URL)
        ).strip()
        if model and responses_url:
            upstreams[upstream_id] = {"id": upstream_id, "model": model, "responses_url": responses_url}

    if upstreams:
        return upstreams

    base_url = (
        os.environ.get("AZURE_OPENAI_BASE_URL")
        or PROXY_CONFIG.get("azure_openai_base_url")
        or DEFAULT_AZURE_OPENAI_BASE_URL
    )
    model = (os.environ.get("AZURE_OPENAI_MODEL") or PROXY_CONFIG.get("azure_model") or "gpt-5.4").strip()
    responses_url = (
        os.environ.get("AZURE_RESPONSES_URL")
        or PROXY_CONFIG.get("azure_responses_url")
        or _responses_url_from_base_url(base_url)
    ).strip()
    return {model: {"id": model, "model": model, "responses_url": responses_url}}


UPSTREAMS = _load_upstreams()
DEFAULT_UPSTREAM_ID = str(PROXY_CONFIG.get("default_upstream") or next(iter(UPSTREAMS))).strip()
DEFAULT_UPSTREAM = UPSTREAMS.get(DEFAULT_UPSTREAM_ID) or next(iter(UPSTREAMS.values()))
DEFAULT_MODEL = DEFAULT_UPSTREAM["model"]
MODEL_FALLBACKS = PROXY_CONFIG.get("model_fallbacks") or []
MODEL_ALIASES = {
    "azure-openai-gpt-5.4-pro": "gpt-5.4-pro",
    "azure-openai-gpt-5.4": "gpt-5.4",
    "claude-haiku-4-5-20251001": "gpt-5.4",
    "claude-sonnet-4-5-20250929": "gpt-5.4",
    "claude-sonnet-4-6": "gpt-5.4",
    "claude-opus-4-5-20251101": "gpt-5.4-pro",
    "claude-opus-4-6": "gpt-5.4-pro",
    "claude-opus-4-7": "gpt-5.4-pro",
    "gpt-5.4-2026-03-05": "gpt-5.4",
    "gpt-5.4-pro-2026-03-05": "gpt-5.4-pro",
    "gpt 5.4pro": "gpt-5.4-pro",
    "gpt-5.4pro": "gpt-5.4-pro",
}
MODEL_ALIASES.update({str(key).lower(): str(value).strip() for key, value in (PROXY_CONFIG.get("model_aliases") or {}).items()})
TRANSIENT_STATUS_CODES = {429, 500, 502, 503, 504}
RETRY_DELAYS = (0.5, 1.5, 3.0)
PLACEHOLDER_API_KEYS = {"reenter-azure-api-key"}
PLACEHOLDER_API_KEY_MESSAGE = (
    "Proma source profile is using a placeholder API key. "
    "Open channel settings and paste the real Azure OpenAI API key."
)


def _log(message):
    encoding = sys.stdout.encoding or "utf-8"
    safe_message = str(message).encode(encoding, errors="backslashreplace").decode(encoding, errors="replace")
    print(safe_message, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as log_file:
            log_file.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {safe_message}\n")
    except OSError:
        pass


def _json_response(handler, status, payload, headers=None):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Connection", "close")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "authorization,content-type,api-key,x-api-key,anthropic-version")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)
    handler.close_connection = True


def _sse_response(handler, chunks):
    handler.close_connection = True
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "close")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    for chunk in chunks:
        handler.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
    handler.wfile.write(b"data: [DONE]\n\n")
    handler.wfile.flush()


def _get_client_api_key(headers):
    for header_name in ("api-key", "x-api-key"):
        api_key = headers.get(header_name)
        if api_key:
            return api_key.strip()
    auth = headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


def _resolve_model(model):
    requested_model = str(model or DEFAULT_MODEL).strip()
    return MODEL_ALIASES.get(requested_model.lower(), requested_model)


def _upstream_for_model(model):
    normalized = str(model or DEFAULT_MODEL).strip().lower()
    for upstream in UPSTREAMS.values():
        if normalized in {upstream["id"].lower(), upstream["model"].lower()}:
            return upstream
    return DEFAULT_UPSTREAM


def _candidate_model_payloads(payload):
    models = []
    for model in [payload.get("model"), DEFAULT_MODEL, *MODEL_FALLBACKS]:
        model = _resolve_model(model)
        if model and model not in models:
            models.append(model)

    for model in models:
        candidate = dict(payload)
        candidate["model"] = model
        yield candidate


def _looks_like_model_404(response):
    if response.status_code != 404:
        return False
    text = response.text.lower()
    return any(marker in text for marker in ("deployment", "model", "not found", "not_found", "404"))


def _post_to_azure(api_key, payload):
    last_error = None
    last_response = None

    for candidate_payload in _candidate_model_payloads(payload):
        upstream = _upstream_for_model(candidate_payload.get("model"))
        body = json.dumps(candidate_payload, ensure_ascii=False).encode("utf-8")
        _log(
            f"Azure Responses upstream: {upstream['id']} "
            f"model={candidate_payload.get('model')} url={upstream['responses_url']}"
        )
        for attempt in range(len(RETRY_DELAYS) + 1):
            try:
                response = requests.post(
                    upstream["responses_url"],
                    headers={
                        "Content-Type": "application/json; charset=utf-8",
                        "Accept": "application/json",
                        "Connection": "close",
                        "api-key": api_key,
                        "x-ms-client-request-id": str(uuid.uuid4()),
                    },
                    data=body,
                    timeout=(10, 120),
                )
                last_response = response
                _log(f"Azure Responses upstream status: {response.status_code}")
                if not response.ok:
                    _log(f"Azure Responses upstream body: {response.text[:1000]}")
                if _looks_like_model_404(response):
                    break
                if response.status_code not in TRANSIENT_STATUS_CODES:
                    return response
            except (ConnectionError, ChunkedEncodingError, ReadTimeout, Timeout, RemoteDisconnected) as exc:
                last_error = exc

            if attempt < len(RETRY_DELAYS):
                time.sleep(RETRY_DELAYS[attempt])
        if last_response is not None and not _looks_like_model_404(last_response):
            return last_response

    if last_response is not None:
        return last_response
    raise requests.RequestException(str(last_error))


def _content_to_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") in {"text", "input_text", "output_text"}:
                    parts.append(str(item.get("text", "")))
                elif item.get("type") == "tool_result":
                    parts.append(_content_to_text(item.get("content")))
                elif "text" in item:
                    parts.append(str(item.get("text", "")))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    return str(content or "")


def _anthropic_text_parts(content):
    if isinstance(content, str):
        return [content] if content else []
    if not isinstance(content, list):
        return [_content_to_text(content)] if content else []

    parts = []
    for item in content:
        if not isinstance(item, dict):
            parts.append(str(item))
            continue
        item_type = item.get("type")
        if item_type == "text":
            parts.append(str(item.get("text", "")))
        elif item_type == "image":
            parts.append("[image omitted]")
        elif item_type == "tool_result":
            tool_text = _content_to_text(item.get("content"))
            if tool_text:
                parts.append(tool_text)
    return [part for part in parts if part]


def _anthropic_content_to_responses_items(message):
    role = message.get("role", "user")
    content = message.get("content", "")
    items = []
    pending_text = []

    def flush_text():
        if pending_text:
            items.append({"role": role, "content": "\n".join(pending_text)})
            pending_text.clear()

    if isinstance(content, str):
        if content:
            items.append({"role": role, "content": content})
        return items

    if not isinstance(content, list):
        text = _content_to_text(content)
        if text:
            items.append({"role": role, "content": text})
        return items

    for block in content:
        if not isinstance(block, dict):
            pending_text.append(str(block))
            continue

        block_type = block.get("type")
        if block_type == "text":
            text = str(block.get("text", ""))
            if text:
                pending_text.append(text)
        elif block_type == "tool_use":
            flush_text()
            items.append(
                {
                    "type": "function_call",
                    "call_id": block.get("id") or f"call_{uuid.uuid4().hex}",
                    "name": block.get("name", ""),
                    "arguments": json.dumps(block.get("input") or {}, ensure_ascii=False),
                }
            )
        elif block_type == "tool_result":
            flush_text()
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": block.get("tool_use_id") or block.get("id") or "",
                    "output": _content_to_text(block.get("content")),
                }
            )
        elif block_type == "image":
            pending_text.append("[image omitted]")
        else:
            text = _content_to_text(block)
            if text:
                pending_text.append(text)

    flush_text()
    return items


def _anthropic_tools_to_responses_tools(tools):
    responses_tools = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if not name:
            continue
        responses_tools.append(
            {
                "type": "function",
                "name": name,
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
            }
        )
    return responses_tools


def _anthropic_tool_choice_to_responses(tool_choice):
    if not tool_choice:
        return None
    if isinstance(tool_choice, str):
        return tool_choice
    if not isinstance(tool_choice, dict):
        return None

    choice_type = tool_choice.get("type")
    if choice_type == "auto":
        return "auto"
    if choice_type == "any":
        return "required"
    if choice_type == "none":
        return "none"
    if choice_type == "tool" and tool_choice.get("name"):
        return {"type": "function", "name": tool_choice["name"]}
    return None


def _anthropic_to_responses_payload(anthropic_payload):
    instructions = _content_to_text(anthropic_payload.get("system"))
    input_items = []
    for message in anthropic_payload.get("messages") or []:
        if isinstance(message, dict):
            input_items.extend(_anthropic_content_to_responses_items(message))

    if not input_items:
        input_items = _content_to_text(anthropic_payload.get("input")) or ""

    payload = {
        "model": _resolve_model(anthropic_payload.get("model")),
        "input": input_items,
        "store": False,
    }

    if instructions:
        payload["instructions"] = instructions
    if "temperature" in anthropic_payload:
        payload["temperature"] = anthropic_payload["temperature"]
    if "top_p" in anthropic_payload:
        payload["top_p"] = anthropic_payload["top_p"]
    if "max_tokens" in anthropic_payload:
        payload["max_output_tokens"] = anthropic_payload["max_tokens"]
    if anthropic_payload.get("stop_sequences"):
        payload["stop"] = anthropic_payload["stop_sequences"]

    tools = _anthropic_tools_to_responses_tools(anthropic_payload.get("tools"))
    if tools:
        payload["tools"] = tools
        tool_choice = _anthropic_tool_choice_to_responses(anthropic_payload.get("tool_choice"))
        if tool_choice:
            payload["tool_choice"] = tool_choice

    return payload


def _messages_to_responses_payload(openai_payload):
    messages = openai_payload.get("messages") or []
    instructions = []
    conversation = []

    for message in messages:
        role = message.get("role", "user")
        text = _content_to_text(message.get("content"))
        if not text:
            continue
        if role in {"system", "developer"}:
            instructions.append(text)
        else:
            conversation.append(f"{role}: {text}")

    model = _resolve_model(openai_payload.get("model"))

    payload = {
        "model": model,
        "input": "\n".join(conversation) if conversation else _content_to_text(openai_payload.get("input")),
        "store": False,
    }

    if instructions:
        payload["instructions"] = "\n".join(instructions)
    if "temperature" in openai_payload:
        payload["temperature"] = openai_payload["temperature"]
    if "top_p" in openai_payload:
        payload["top_p"] = openai_payload["top_p"]
    if "max_tokens" in openai_payload:
        payload["max_output_tokens"] = openai_payload["max_tokens"]
    if "max_completion_tokens" in openai_payload:
        payload["max_output_tokens"] = openai_payload["max_completion_tokens"]

    return payload


def _extract_output_text(azure_payload):
    texts = []
    for item in azure_payload.get("output", []):
        for content in item.get("content", []) or []:
            if content.get("type") in {"output_text", "text"}:
                texts.append(content.get("text", ""))
    return "".join(texts)


def _parse_tool_arguments(arguments):
    if isinstance(arguments, dict):
        return arguments
    if arguments in (None, ""):
        return {}
    try:
        return json.loads(arguments)
    except (TypeError, ValueError):
        return {"arguments": str(arguments)}


def _optional_tool_fields_by_name(tools):
    optional_fields = {}
    for tool in tools or []:
        if not isinstance(tool, dict) or not tool.get("name"):
            continue
        schema = tool.get("input_schema") or {}
        properties = set((schema.get("properties") or {}).keys())
        required = set(schema.get("required") or [])
        optional_fields[tool["name"]] = properties - required
    return optional_fields


def _sanitize_tool_input(tool_name, tool_input, optional_fields_by_name):
    if not isinstance(tool_input, dict):
        return tool_input
    optional_fields = optional_fields_by_name.get(tool_name, set())
    if not optional_fields:
        return tool_input
    return {
        key: value
        for key, value in tool_input.items()
        if not (key in optional_fields and (value is None or value == ""))
    }


def _extract_tool_calls(azure_payload, optional_fields_by_name=None):
    optional_fields_by_name = optional_fields_by_name or {}
    calls = []
    for item in azure_payload.get("output", []):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "function_call":
            name = item.get("name", "")
            tool_input = _parse_tool_arguments(item.get("arguments"))
            calls.append(
                {
                    "id": item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex}",
                    "name": name,
                    "input": _sanitize_tool_input(name, tool_input, optional_fields_by_name),
                }
            )
    return calls


def _anthropic_usage(azure_payload):
    usage = azure_payload.get("usage") or {}
    return {
        "input_tokens": usage.get("input_tokens") or usage.get("prompt_tokens") or 0,
        "output_tokens": usage.get("output_tokens") or usage.get("completion_tokens") or 0,
    }


def _anthropic_stop_reason(azure_payload, tool_calls):
    if tool_calls:
        return "tool_use"
    incomplete = azure_payload.get("incomplete_details") or {}
    if incomplete.get("reason") == "max_output_tokens":
        return "max_tokens"
    return "end_turn"


def _anthropic_message_payload(request_model, azure_payload, tools=None):
    text = _extract_output_text(azure_payload)
    tool_calls = _extract_tool_calls(azure_payload, _optional_tool_fields_by_name(tools))
    _log(
        f"Anthropic response summary: text_chars={len(text)} tool_calls={len(tool_calls)} "
        f"status={azure_payload.get('status')}"
    )
    if text:
        _log(f"Anthropic response text preview: {text[:500]}")
    content = []
    if text:
        content.append({"type": "text", "text": text})
    for call in tool_calls:
        content.append({"type": "tool_use", "id": call["id"], "name": call["name"], "input": call["input"]})
    if not content:
        content.append({"type": "text", "text": ""})

    return {
        "id": azure_payload.get("id") or f"msg_{uuid.uuid4().hex}",
        "type": "message",
        "role": "assistant",
        "model": request_model,
        "content": content,
        "stop_reason": _anthropic_stop_reason(azure_payload, tool_calls),
        "stop_sequence": None,
        "usage": _anthropic_usage(azure_payload),
    }


def _chat_completion_payload(model, text):
    now = int(time.time())
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": now,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
    }


def _chat_completion_chunks(model, text):
    now = int(time.time())
    chunk_id = f"chatcmpl-{uuid.uuid4().hex}"
    return [
        {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": now,
            "model": model,
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}],
        },
        {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": now,
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        },
    ]


def _send_anthropic_sse_event(handler, event, payload):
    handler.wfile.write(f"event: {event}\n".encode("utf-8"))
    handler.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
    handler.wfile.flush()


def _anthropic_sse_response(handler, message):
    handler.close_connection = True
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "close")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()

    start_message = dict(message)
    start_message["content"] = []
    start_message["stop_reason"] = None
    start_message["stop_sequence"] = None
    start_message["usage"] = {"input_tokens": message.get("usage", {}).get("input_tokens", 0), "output_tokens": 0}
    _send_anthropic_sse_event(
        handler,
        "message_start",
        {"type": "message_start", "message": start_message},
    )

    for index, block in enumerate(message.get("content") or []):
        block_type = block.get("type")
        if block_type == "text":
            _send_anthropic_sse_event(
                handler,
                "content_block_start",
                {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}},
            )
            text = block.get("text", "")
            if text:
                _send_anthropic_sse_event(
                    handler,
                    "content_block_delta",
                    {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}},
                )
            _send_anthropic_sse_event(
                handler,
                "content_block_stop",
                {"type": "content_block_stop", "index": index},
            )
        elif block_type == "tool_use":
            tool_block = {"type": "tool_use", "id": block.get("id"), "name": block.get("name"), "input": {}}
            _send_anthropic_sse_event(
                handler,
                "content_block_start",
                {"type": "content_block_start", "index": index, "content_block": tool_block},
            )
            partial_json = json.dumps(block.get("input") or {}, ensure_ascii=False)
            _send_anthropic_sse_event(
                handler,
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {"type": "input_json_delta", "partial_json": partial_json},
                },
            )
            _send_anthropic_sse_event(
                handler,
                "content_block_stop",
                {"type": "content_block_stop", "index": index},
            )

    _send_anthropic_sse_event(
        handler,
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": message.get("stop_reason"), "stop_sequence": message.get("stop_sequence")},
            "usage": {"output_tokens": message.get("usage", {}).get("output_tokens", 0)},
        },
    )
    _send_anthropic_sse_event(handler, "message_stop", {"type": "message_stop"})
    _log(f"Anthropic SSE completed: stop_reason={message.get('stop_reason')}")
    handler.wfile.flush()


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        _log("%s - %s" % (self.address_string(), fmt % args))

    def _handle_unexpected_error(self, exc):
        _log(f"Unhandled proxy error: {exc}\n{traceback.format_exc()}")
        try:
            if self.path.split("?", 1)[0].rstrip("/") in {"/messages", "/v1/messages"}:
                return _json_response(
                    self,
                    502,
                    {"type": "error", "error": {"type": "api_error", "message": f"Local proxy error: {exc}"}},
                )
            return _json_response(self, 502, {"error": {"message": f"Local proxy error: {exc}"}})
        except Exception:
            self.close_connection = True

    def do_OPTIONS(self):
        try:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "authorization,content-type,api-key,x-api-key,anthropic-version")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
        except Exception as exc:
            return self._handle_unexpected_error(exc)

    def do_HEAD(self):
        try:
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
        except Exception as exc:
            return self._handle_unexpected_error(exc)

    def do_GET(self):
        try:
            if self.path.rstrip("/") in {"/health", "/v1/health"}:
                return _json_response(self, 200, {"status": "ok"})
            if self.path.rstrip("/") in {"/models", "/v1/models"}:
                return _json_response(
                    self,
                    200,
                    {
                        "object": "list",
                        "data": [
                            {"id": upstream["model"], "object": "model", "created": 0, "owned_by": "azure"}
                            for upstream in UPSTREAMS.values()
                        ],
                    },
                )
            return _json_response(self, 404, {"error": {"message": "Not found"}})
        except Exception as exc:
            return self._handle_unexpected_error(exc)

    def do_POST(self):
        try:
            path = self.path.split("?", 1)[0].rstrip("/")
            if path in {"/messages", "/v1/messages"}:
                return self._handle_anthropic_messages()
            if path not in {"/chat/completions", "/v1/chat/completions"}:
                return _json_response(self, 404, {"error": {"message": "Not found"}})

            return self._handle_chat_completions()
        except Exception as exc:
            return self._handle_unexpected_error(exc)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(length)
        return json.loads(raw_body.decode("utf-8"))

    def _handle_chat_completions(self):
        api_key = _get_client_api_key(self.headers)
        if not api_key:
            return _json_response(self, 401, {"error": {"message": "Missing API key"}})
        if api_key in PLACEHOLDER_API_KEYS:
            return _json_response(self, 401, {"error": {"message": PLACEHOLDER_API_KEY_MESSAGE}})

        try:
            openai_payload = self._read_json_body()
        except json.JSONDecodeError as exc:
            return _json_response(self, 400, {"error": {"message": f"Invalid JSON: {exc}"}})

        azure_payload = _messages_to_responses_payload(openai_payload)
        try:
            response = _post_to_azure(api_key, azure_payload)
        except requests.RequestException as exc:
            return _json_response(self, 502, {"error": {"message": str(exc)}})

        if not response.ok:
            try:
                detail = response.json()
            except ValueError:
                detail = {"message": response.text}
            return _json_response(self, response.status_code, {"error": detail})

        azure_data = response.json()
        text = _extract_output_text(azure_data)
        model = azure_payload.get("model") or DEFAULT_MODEL
        if openai_payload.get("stream"):
            return _sse_response(self, _chat_completion_chunks(model, text))
        return _json_response(self, 200, _chat_completion_payload(model, text))

    def _handle_anthropic_messages(self):
        api_key = _get_client_api_key(self.headers)
        if not api_key:
            return _json_response(
                self,
                401,
                {"type": "error", "error": {"type": "authentication_error", "message": "Missing API key"}},
            )
        if api_key in PLACEHOLDER_API_KEYS:
            return _json_response(
                self,
                401,
                {"type": "error", "error": {"type": "authentication_error", "message": PLACEHOLDER_API_KEY_MESSAGE}},
            )

        try:
            anthropic_payload = self._read_json_body()
        except json.JSONDecodeError as exc:
            return _json_response(
                self,
                400,
                {"type": "error", "error": {"type": "invalid_request_error", "message": f"Invalid JSON: {exc}"}},
            )

        _log(
            f"Anthropic request: path={self.path} model={anthropic_payload.get('model')} "
            f"stream={anthropic_payload.get('stream')} messages={len(anthropic_payload.get('messages') or [])} "
            f"tools={len(anthropic_payload.get('tools') or [])}"
        )
        azure_payload = _anthropic_to_responses_payload(anthropic_payload)
        try:
            response = _post_to_azure(api_key, azure_payload)
        except requests.RequestException as exc:
            return _json_response(
                self,
                502,
                {"type": "error", "error": {"type": "api_error", "message": str(exc)}},
            )

        if not response.ok:
            try:
                detail = response.json()
            except ValueError:
                detail = {"message": response.text}
            message = detail.get("error", detail)
            if isinstance(message, dict):
                message = message.get("message") or json.dumps(message, ensure_ascii=False)
            return _json_response(
                self,
                response.status_code,
                {"type": "error", "error": {"type": "api_error", "message": str(message)}},
            )

        azure_data = response.json()
        message = _anthropic_message_payload(
            anthropic_payload.get("model") or DEFAULT_MODEL,
            azure_data,
            tools=anthropic_payload.get("tools"),
        )
        if anthropic_payload.get("stream"):
            return _anthropic_sse_response(self, message)
        return _json_response(self, 200, message)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8787), ProxyHandler)
    _log("Azure Responses proxy listening on http://127.0.0.1:8787")
    server.serve_forever()
