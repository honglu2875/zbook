"""Authenticated WebSocket bridge between the browser and Codex App Server."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.base.websocket import WebSocketMixin
from tornado.websocket import WebSocketClosedError, WebSocketHandler

from .codex import CodexAppServer

_APPROVAL_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
}
_APPROVAL_DECISIONS = {"accept", "acceptForSession", "decline", "cancel"}
_NOTEBOOK_TOOL_METHOD = "item/tool/call"
_NOTEBOOK_TOOLS = {"zbook_notebook_read", "zbook_notebook_apply"}
_NOTEBOOK_TOOL_TIMEOUT = 45.0
_PREFERRED_MODEL = "gpt-5.6-luna"
_PREFERRED_EFFORT = "medium"


def choose_default_model(models: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    """Prefer Luna/medium while respecting the catalog exposed by this CLI/account."""
    if not models:
        return None, None
    selected = next(
        (
            item
            for item in models
            if item.get("model") == _PREFERRED_MODEL or item.get("id") == _PREFERRED_MODEL
        ),
        None,
    )
    if selected is None:
        selected = next((item for item in models if item.get("isDefault") is True), models[0])
    efforts = [
        option.get("reasoningEffort")
        for option in selected.get("supportedReasoningEfforts", [])
        if isinstance(option, dict) and isinstance(option.get("reasoningEffort"), str)
    ]
    default_effort = selected.get("defaultReasoningEffort")
    effort = (
        _PREFERRED_EFFORT
        if _PREFERRED_EFFORT in efforts
        else default_effort
        if isinstance(default_effort, str) and default_effort in efforts
        else efforts[0]
        if efforts
        else None
    )
    model = selected.get("model") or selected.get("id")
    return (model if isinstance(model, str) else None), effort


def prompt_with_context(prompt: str, context: Any) -> str:
    value = prompt.strip()
    if not isinstance(context, dict):
        return value
    notebook = context.get("notebook")
    cell_kind = context.get("cellKind")
    cell_id = context.get("cellId")
    source = context.get("source")
    details: list[str] = []
    if isinstance(notebook, str) and notebook:
        details.append(f"Open notebook: {notebook[:4_000]}")
    if isinstance(cell_kind, str) and isinstance(source, str):
        language = "python" if cell_kind == "code" else "markdown"
        identity = f" (notebook cell id: {cell_id[:200]})" if isinstance(cell_id, str) else ""
        details.append(
            f"Selected {cell_kind} cell{identity}:\n"
            f"```{language}\n{source[:20_000]}\n```"
        )
    if not details:
        return value
    return f"{value}\n\nZbook context supplied by the user:\n" + "\n\n".join(details)


def dynamic_tool_response(success: bool, result: Any) -> dict[str, Any]:
    """Encode the exact DynamicToolCallResponse shape expected by App Server."""
    return {
        "success": success,
        "contentItems": [
            {
                "type": "inputText",
                "text": json.dumps(result, ensure_ascii=False, separators=(",", ":")),
            }
        ],
    }


def _message_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict) and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "\n".join(part for part in parts if part)


def thread_messages(thread: Any) -> list[dict[str, str]]:
    """Reduce a persisted App Server thread to the conversation shown by Zbook."""
    if not isinstance(thread, dict) or not isinstance(thread.get("turns"), list):
        return []
    messages: list[dict[str, str]] = []
    for turn_index, turn in enumerate(thread["turns"]):
        if not isinstance(turn, dict) or not isinstance(turn.get("items"), list):
            continue
        for item_index, item in enumerate(turn["items"]):
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type == "userMessage":
                role = "user"
                text = _message_content_text(item.get("content"))
            elif item_type == "agentMessage":
                role = "assistant"
                text = item.get("text") if isinstance(item.get("text"), str) else ""
            else:
                continue
            if not text.strip():
                continue
            item_id = item.get("id")
            messages.append(
                {
                    "id": item_id
                    if isinstance(item_id, str)
                    else f"history-{turn_index}-{item_index}",
                    "role": role,
                    "text": text,
                }
            )
    return messages


class CodexWebSocketHandler(WebSocketMixin, WebSocketHandler, JupyterHandler):
    """Expose one workspace-scoped Codex conversation to the local web client."""

    auth_resource = "zbook"
    codex: CodexAppServer | None = None
    thread_id: str | None = None
    turn_id: str | None = None
    event_task: asyncio.Task[None] | None = None
    approval_ids: set[int | str]
    notebook_tool_ids: set[int | str]
    notebook_tool_timeouts: dict[int | str, asyncio.Task[None]]
    models: list[dict[str, Any]]
    selected_model: str | None = None
    selected_effort: str | None = None
    account_state: dict[str, Any]

    def set_default_headers(self) -> None:
        """Jupyter's normal HTTP headers do not apply after a WebSocket upgrade."""

    @ws_authenticated
    async def get(self) -> None:
        await super().get()

    async def open(self) -> None:
        super().open()
        self.approval_ids = set()
        self.notebook_tool_ids = set()
        self.notebook_tool_timeouts = {}
        self.models = []
        self.account_state = {"account": None, "requiresOpenaiAuth": True}
        self.selected_model = None
        self.selected_effort = None
        try:
            app = self.settings["zbook_app"]
            self.codex = await app.get_codex()
            self.event_task = asyncio.create_task(self._forward_events())
            await self._send_account_state(refresh_models=True)
        except Exception as error:  # The process boundary can fail for several local reasons.
            self.log.exception("Could not initialize the Codex bridge")
            await self._send({"type": "error", "message": str(error)})
            self.close(code=1011, reason="Codex bridge unavailable")

    async def on_message(self, raw_message: str | bytes) -> None:
        try:
            message = json.loads(raw_message)
            if not isinstance(message, dict):
                raise ValueError("Codex messages must be JSON objects")
            await self._handle_message(message)
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            await self._send({"type": "error", "message": str(error)})
        except Exception as error:  # Keep the panel usable after a failed CLI request.
            self.log.exception("Codex bridge request failed")
            await self._send({"type": "error", "message": str(error)})

    async def _handle_message(self, message: dict[str, Any]) -> None:
        if self.codex is None:
            raise RuntimeError("Codex CLI is not connected")
        message_type = message.get("type")
        if message_type == "prompt":
            prompt = message.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                raise ValueError("Prompt cannot be empty")
            if len(prompt) > 200_000:
                raise ValueError("Prompt is too large")
            if self.turn_id is not None:
                raise ValueError("A Codex turn is already running")
            model, effort = self._resolve_settings(message)
            if self.thread_id is None:
                result = await self.codex.start_thread(model)
                self.thread_id = result["thread"]["id"]
                await self._send(
                    {
                        "type": "thread",
                        "threadId": self.thread_id,
                        "thread": result.get("thread"),
                    }
                )
            result = await self.codex.start_turn(
                self.thread_id,
                prompt_with_context(prompt, message.get("context")),
                model=model,
                effort=effort,
            )
            turn = result.get("turn", {})
            self.turn_id = turn.get("id")
            await self._send(
                {
                    "type": "turn",
                    "turnId": self.turn_id,
                    "model": model,
                    "effort": effort,
                }
            )
            return
        if message_type == "approval":
            request_id = message.get("requestId")
            decision = message.get("decision")
            if request_id not in self.approval_ids:
                raise ValueError("Unknown or expired approval request")
            if decision not in _APPROVAL_DECISIONS:
                raise ValueError("Invalid approval decision")
            await self.codex.respond(request_id, {"decision": decision})
            self.approval_ids.discard(request_id)
            await self._send({"type": "approvalResolved", "requestId": request_id})
            return
        if message_type == "notebookToolResult":
            request_id = message.get("requestId")
            if request_id not in self.notebook_tool_ids:
                raise ValueError("Unknown or expired notebook tool request")
            success = message.get("success")
            if not isinstance(success, bool):
                raise ValueError("Notebook tool success must be a boolean")
            await self._complete_notebook_tool(request_id, success, message.get("result"))
            return
        if message_type == "interrupt":
            if self.thread_id and self.turn_id:
                await self.codex.interrupt_turn(self.thread_id, self.turn_id)
            return
        if message_type == "login":
            result = await self.codex.start_chatgpt_login()
            await self._send({"type": "login", "result": result})
            return
        if message_type == "logout":
            if self.turn_id is not None:
                raise ValueError("Stop the active Codex turn before signing out")
            await self.codex.logout()
            self.thread_id = None
            await self._send_account_state(refresh_models=True)
            return
        if message_type == "refreshAccount":
            await self._send_account_state(refresh_models=True)
            return
        if message_type == "newThread":
            if self.turn_id is not None:
                raise ValueError("Stop the active Codex turn before starting a new thread")
            self.thread_id = None
            self.turn_id = None
            await self._send({"type": "thread", "threadId": None})
            return
        if message_type == "resumeThread":
            if self.turn_id is not None:
                raise ValueError("Stop the active Codex turn before switching threads")
            thread_id = message.get("threadId")
            if not isinstance(thread_id, str) or not thread_id.strip() or len(thread_id) > 200:
                raise ValueError("A valid Codex thread ID is required")
            model, _ = self._resolve_settings(message)
            try:
                history_result = await self.codex.read_thread(thread_id)
                resume_result = await self.codex.resume_thread(thread_id, model)
                resumed_thread = resume_result.get("thread", {})
                resumed_id = resumed_thread.get("id")
                if not isinstance(resumed_id, str):
                    raise RuntimeError("Codex did not return a resumed thread ID")
                history_thread = history_result.get("thread", {})
                self.thread_id = resumed_id
                self.turn_id = None
                await self._send(
                    {
                        "type": "threadRestored",
                        "threadId": resumed_id,
                        "thread": {
                            "id": resumed_id,
                            "name": history_thread.get("name"),
                            "preview": history_thread.get("preview"),
                            "updatedAt": history_thread.get("updatedAt"),
                        },
                        "messages": thread_messages(history_thread),
                    }
                )
            except Exception as error:
                self.log.warning("Could not resume Codex thread %s: %s", thread_id, error)
                self.thread_id = None
                self.turn_id = None
                await self._send(
                    {
                        "type": "threadUnavailable",
                        "threadId": thread_id,
                        "message": str(error),
                    }
                )
            return
        raise ValueError(f"Unknown Codex message type: {message_type!r}")

    def _resolve_settings(self, message: dict[str, Any]) -> tuple[str | None, str | None]:
        requested_model = message.get("model", self.selected_model)
        requested_effort = message.get("effort", self.selected_effort)
        if requested_model is not None and not isinstance(requested_model, str):
            raise ValueError("Codex model must be a string")
        if requested_effort is not None and not isinstance(requested_effort, str):
            raise ValueError("Codex reasoning effort must be a string")

        if not self.models:
            self.selected_model = requested_model
            self.selected_effort = requested_effort
            return requested_model, requested_effort

        selected = next(
            (
                item
                for item in self.models
                if item.get("model") == requested_model or item.get("id") == requested_model
            ),
            None,
        )
        if selected is None:
            raise ValueError(f"Codex model is not available: {requested_model}")
        model = selected.get("model") or selected.get("id")
        supported = [
            option.get("reasoningEffort")
            for option in selected.get("supportedReasoningEfforts", [])
            if isinstance(option, dict) and isinstance(option.get("reasoningEffort"), str)
        ]
        if requested_effort not in supported:
            if requested_effort is not None:
                raise ValueError(
                    f"{requested_effort!r} reasoning is not available for {model}"
                )
            default_effort = selected.get("defaultReasoningEffort")
            requested_effort = (
                default_effort
                if isinstance(default_effort, str) and default_effort in supported
                else supported[0]
                if supported
                else None
            )
        self.selected_model = model if isinstance(model, str) else None
        self.selected_effort = requested_effort
        return self.selected_model, self.selected_effort

    async def _send_account_state(self, *, refresh_models: bool) -> None:
        assert self.codex is not None
        account = await self.codex.account()
        if not isinstance(account, dict):
            raise RuntimeError("Codex returned an invalid account response")
        self.account_state = account
        model_error: str | None = None
        if refresh_models:
            try:
                result = await self.codex.models()
                data = result.get("data") if isinstance(result, dict) else None
                self.models = [item for item in data or [] if isinstance(item, dict)]
            except Exception as error:
                model_error = str(error)
                self.log.warning("Could not load the Codex model catalog: %s", error)

        available = {
            item.get("model") or item.get("id") for item in self.models if isinstance(item, dict)
        }
        if self.selected_model not in available:
            self.selected_model, self.selected_effort = choose_default_model(self.models)
        await self._send(
            {
                "type": "ready",
                "account": account,
                "models": self.models,
                "defaults": {
                    "model": self.selected_model,
                    "effort": self.selected_effort,
                },
                "modelError": model_error,
            }
        )
        await self._send_rate_limits()

    async def _send_rate_limits(self) -> None:
        assert self.codex is not None
        account = self.account_state.get("account")
        if not isinstance(account, dict) or account.get("type") != "chatgpt":
            await self._send({"type": "rateLimits", "rateLimits": None, "error": None})
            return
        try:
            rate_limits = await self.codex.rate_limits()
        except Exception as error:
            self.log.warning("Could not load Codex rate limits: %s", error)
            await self._send(
                {"type": "rateLimits", "rateLimits": None, "error": str(error)}
            )
            return
        await self._send({"type": "rateLimits", "rateLimits": rate_limits, "error": None})

    async def _forward_events(self) -> None:
        assert self.codex is not None
        try:
            async for event in self.codex.events():
                params = event.get("params")
                event_thread = params.get("threadId") if isinstance(params, dict) else None
                if event_thread and event_thread != self.thread_id:
                    continue
                method = event.get("method")
                if method == _NOTEBOOK_TOOL_METHOD:
                    await self._forward_notebook_tool(event, params)
                    continue
                if method in _APPROVAL_METHODS and event.get("id") is not None:
                    self.approval_ids.add(event["id"])
                if method == "serverRequest/resolved" and isinstance(params, dict):
                    request_id = params.get("requestId")
                    self.approval_ids.discard(request_id)
                    self._forget_notebook_tool(request_id)
                await self._send({"type": "codex", "message": event})
                if method == "turn/completed":
                    self.turn_id = None
                    await self._send_rate_limits()
                elif method in {"account/login/completed", "account/updated"}:
                    await self._send_account_state(refresh_models=True)
                elif method == "model/rerouted" and isinstance(params, dict):
                    model = params.get("toModel")
                    if isinstance(model, str):
                        self.selected_model = model
                        await self._send(
                            {
                                "type": "settings",
                                "model": model,
                                "effort": self.selected_effort,
                            }
                        )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.log.exception("Codex event stream failed")
            await self._send({"type": "error", "message": str(error)})
        else:
            if not self.codex.running:
                await self._send(
                    {
                        "type": "error",
                        "message": "The Codex CLI stopped before the conversation completed.",
                    }
                )

    async def _forward_notebook_tool(
        self,
        event: dict[str, Any],
        params: Any,
    ) -> None:
        assert self.codex is not None
        request_id = event.get("id")
        if request_id is None or not isinstance(params, dict):
            return
        tool = params.get("tool")
        if tool not in _NOTEBOOK_TOOLS:
            await self.codex.respond(
                request_id,
                dynamic_tool_response(False, {"error": f"Unknown Zbook tool: {tool}"}),
            )
            return
        self.notebook_tool_ids.add(request_id)
        timeout = asyncio.create_task(self._expire_notebook_tool(request_id))
        self.notebook_tool_timeouts[request_id] = timeout
        await self._send(
            {
                "type": "notebookToolCall",
                "requestId": request_id,
                "callId": params.get("callId"),
                "threadId": params.get("threadId"),
                "turnId": params.get("turnId"),
                "tool": tool,
                "arguments": params.get("arguments"),
            }
        )

    async def _complete_notebook_tool(
        self,
        request_id: int | str,
        success: bool,
        result: Any,
    ) -> None:
        assert self.codex is not None
        if request_id not in self.notebook_tool_ids:
            return
        self.notebook_tool_ids.discard(request_id)
        timeout = self.notebook_tool_timeouts.pop(request_id, None)
        if timeout is not None and timeout is not asyncio.current_task():
            timeout.cancel()
        await self.codex.respond(request_id, dynamic_tool_response(success, result))

    def _forget_notebook_tool(self, request_id: Any) -> None:
        self.notebook_tool_ids.discard(request_id)
        timeout = self.notebook_tool_timeouts.pop(request_id, None)
        if timeout is not None:
            timeout.cancel()

    async def _expire_notebook_tool(self, request_id: int | str) -> None:
        try:
            await asyncio.sleep(_NOTEBOOK_TOOL_TIMEOUT)
            await self._complete_notebook_tool(
                request_id,
                False,
                {"error": "The Zbook browser did not answer the notebook tool call in time."},
            )
            await self._send(
                {
                    "type": "error",
                    "message": "A Codex notebook edit timed out before the browser answered.",
                }
            )
        except asyncio.CancelledError:
            raise

    async def _send(self, payload: dict[str, Any]) -> None:
        try:
            await self.write_message(json.dumps(payload))
        except WebSocketClosedError:
            pass

    def on_close(self) -> None:
        if self.event_task is not None:
            self.event_task.cancel()
        if self.codex is not None:
            if self.thread_id and self.turn_id:
                asyncio.create_task(self._interrupt(self.thread_id, self.turn_id))
            for request_id in getattr(self, "approval_ids", set()):
                asyncio.create_task(self._decline(request_id))
            pending_tools = list(getattr(self, "notebook_tool_ids", set()))
            self.notebook_tool_ids.clear()
            for request_id in pending_tools:
                asyncio.create_task(self._fail_disconnected_tool(request_id))
        for timeout in getattr(self, "notebook_tool_timeouts", {}).values():
            timeout.cancel()
        self.thread_id = None
        self.turn_id = None
        self.approval_ids = set()
        self.notebook_tool_ids = set()
        self.notebook_tool_timeouts = {}

    async def _interrupt(self, thread_id: str, turn_id: str) -> None:
        assert self.codex is not None
        with contextlib.suppress(Exception):
            await self.codex.interrupt_turn(thread_id, turn_id)

    async def _decline(self, request_id: int | str) -> None:
        assert self.codex is not None
        with contextlib.suppress(Exception):
            await self.codex.respond(request_id, {"decision": "decline"})

    async def _fail_disconnected_tool(self, request_id: int | str) -> None:
        assert self.codex is not None
        with contextlib.suppress(Exception):
            await self.codex.respond(
                request_id,
                dynamic_tool_response(
                    False,
                    {"error": "The Zbook browser disconnected during the notebook tool call."},
                ),
            )
