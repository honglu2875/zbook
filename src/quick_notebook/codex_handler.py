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


def prompt_with_context(prompt: str, context: Any) -> str:
    value = prompt.strip()
    if not isinstance(context, dict):
        return value
    notebook = context.get("notebook")
    cell_kind = context.get("cellKind")
    source = context.get("source")
    details: list[str] = []
    if isinstance(notebook, str) and notebook:
        details.append(f"Open notebook: {notebook[:4_000]}")
    if isinstance(cell_kind, str) and isinstance(source, str):
        language = "python" if cell_kind == "code" else "markdown"
        details.append(f"Selected {cell_kind} cell:\n```{language}\n{source[:20_000]}\n```")
    if not details:
        return value
    return f"{value}\n\nQuick Notebook context supplied by the user:\n" + "\n\n".join(details)


class CodexWebSocketHandler(WebSocketMixin, WebSocketHandler, JupyterHandler):
    """Expose one workspace-scoped Codex conversation to the local web client."""

    auth_resource = "quick-notebook"
    codex: CodexAppServer | None = None
    thread_id: str | None = None
    turn_id: str | None = None
    event_task: asyncio.Task[None] | None = None
    approval_ids: set[int | str]

    def set_default_headers(self) -> None:
        """Jupyter's normal HTTP headers do not apply after a WebSocket upgrade."""

    @ws_authenticated
    async def get(self) -> None:
        await super().get()

    async def open(self) -> None:
        super().open()
        self.approval_ids: set[int | str] = set()
        try:
            app = self.settings["quick_notebook_app"]
            self.codex = await app.get_codex()
            account = await self.codex.account()
            self.event_task = asyncio.create_task(self._forward_events())
            await self._send({"type": "ready", "account": account})
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
            if self.thread_id is None:
                result = await self.codex.start_thread()
                self.thread_id = result["thread"]["id"]
                await self._send({"type": "thread", "threadId": self.thread_id})
            result = await self.codex.start_turn(
                self.thread_id,
                prompt_with_context(prompt, message.get("context")),
            )
            turn = result.get("turn", {})
            self.turn_id = turn.get("id")
            await self._send({"type": "turn", "turnId": self.turn_id})
            return
        if message_type == "approval":
            request_id = message.get("requestId")
            decision = message.get("decision")
            if request_id not in self.approval_ids:
                raise ValueError("Unknown or expired approval request")
            if decision not in _APPROVAL_DECISIONS:
                raise ValueError("Invalid approval decision")
            self.approval_ids.discard(request_id)
            await self.codex.respond(request_id, {"decision": decision})
            await self._send({"type": "approvalResolved", "requestId": request_id})
            return
        if message_type == "interrupt":
            if self.thread_id and self.turn_id:
                await self.codex.interrupt_turn(self.thread_id, self.turn_id)
            return
        if message_type == "login":
            result = await self.codex.start_chatgpt_login()
            await self._send({"type": "login", "result": result})
            return
        if message_type == "newThread":
            self.thread_id = None
            self.turn_id = None
            await self._send({"type": "thread", "threadId": None})
            return
        raise ValueError(f"Unknown Codex message type: {message_type!r}")

    async def _forward_events(self) -> None:
        assert self.codex is not None
        async for event in self.codex.events():
            params = event.get("params")
            event_thread = params.get("threadId") if isinstance(params, dict) else None
            if event_thread and event_thread != self.thread_id:
                continue
            if event.get("method") in _APPROVAL_METHODS and event.get("id") is not None:
                self.approval_ids.add(event["id"])
            await self._send({"type": "codex", "message": event})
            if event.get("method") == "turn/completed":
                self.turn_id = None
            if event.get("method") in {"account/login/completed", "account/updated"}:
                await self._send({"type": "ready", "account": await self.codex.account()})

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
        self.thread_id = None
        self.turn_id = None
        self.approval_ids = set()

    async def _interrupt(self, thread_id: str, turn_id: str) -> None:
        assert self.codex is not None
        with contextlib.suppress(Exception):
            await self.codex.interrupt_turn(thread_id, turn_id)

    async def _decline(self, request_id: int | str) -> None:
        assert self.codex is not None
        with contextlib.suppress(Exception):
            await self.codex.respond(request_id, {"decision": "decline"})
