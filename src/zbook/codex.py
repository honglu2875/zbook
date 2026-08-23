"""Async JSONL transport for a local, subscription-authenticated Codex CLI."""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any


class CodexUnavailable(RuntimeError):
    pass


class CodexProtocolError(RuntimeError):
    pass


class CodexRequestError(RuntimeError):
    pass


DEFAULT_REQUEST_TIMEOUT = 30.0

NOTEBOOK_TOOL_INSTRUCTIONS = """You are embedded in Zbook. When reading or changing the open
notebook, use Zbook's notebook tools instead of editing the .ipynb file with shell commands or
apply_patch. Read immediately before editing and pass its notebookPath and documentRevision as
expectedRevision. If the user's request requires modifying existing cells, identify the relevant
cells on the first read and immediately lock the likely set with zbook_notebook_lock before further
investigation, reasoning, or tool actions; expand the locked set later if needed. Keep those locks
while you read, reason, stage edits, check, and revise across the turn; unlock cells early only when
they are no longer relevant. Locks do not change documentRevision and release automatically when
the turn ends.

For source edits to existing cells, never use replace_source in zbook_notebook_apply. Instead call
zbook_notebook_propose once per small coherent hunk so the user sees the diff develop live. Each
stage_hunk call must describe the exact current oldLines and replacement newLines, use the latest
proposalRevision returned by the prior call, and contain only one logical edit. A proposal is not
saved into the notebook until the user chooses Apply or Apply & Run in Zbook; you cannot accept a
proposal on the user's behalf. If a read reports a proposal from an earlier turn, lock the cell and
either replace the complete proposal with replace_proposal or remove it with discard_proposal;
do not layer stage_hunk calls over an earlier-turn proposal. If you need to reread while building a
proposal in the current turn, its source is the current draft and pendingChange contains the diff.

If an operation reports a conflict, read again before retrying. If you are unsure which notebook
actions are currently available, call zbook_notebook_read: its availableActions field is the
authoritative live tool inventory. If a call reports cells_not_locked, immediately call the exact
tool and arguments returned in nextAction; never ask the user to lock cells in the UI.
For a reorder-only task, read with includeSource false, lock the cells whose positions matter,
then use move_after or swap operations in zbook_notebook_apply without resending source. Structural
operations remain atomic and saved immediately. Shell tools remain appropriate for non-notebook
workspace files."""

NOTEBOOK_DYNAMIC_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "zbook_notebook_read",
        "description": (
            "Read the notebook currently open in the Zbook UI, including stable cell IDs and the "
            "document revision needed for edits. Use this instead of reading the .ipynb with shell "
            "commands. Set includeSource to false for reorder-only work to avoid loading cell "
            "contents into context; it defaults to true. Every response also reports the live "
            "availableActions tool inventory, making this the capability-discovery endpoint."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "includeSource": {
                    "type": "boolean",
                    "default": True,
                    "description": "Include each cell's source. Use false for reordering only.",
                }
            },
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "zbook_notebook_lock",
        "description": (
            "Lock or unlock existing cells in the Zbook UI for the current Codex turn. Before "
            "working on a modification, lock likely relevant cells immediately after the first "
            "read so the user cannot edit or execute them while you continue investigating, "
            "reasoning, and making multiple tool calls. Locks do not change the notebook revision "
            "and automatically release when the turn ends."
        ),
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "notebookPath",
                "expectedRevision",
                "action",
                "cellIds",
            ],
            "properties": {
                "notebookPath": {"type": "string"},
                "expectedRevision": {"type": "integer", "minimum": 0},
                "action": {"enum": ["lock", "unlock"]},
                "cellIds": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 100,
                    "uniqueItems": True,
                    "items": {"type": "string"},
                },
            },
        },
    },
    {
        "type": "function",
        "name": "zbook_notebook_propose",
        "description": (
            "Stage a source-code proposal in a locked existing cell without changing or saving "
            "the accepted notebook. For a clean cell, call stage_hunk once per small coherent "
            "edit and use the proposalRevision returned by each call in the next call. Each hunk "
            "atomically replaces exact whole oldLines beginning at the one-based startLine with "
            "newLines; pure insertions use an empty oldLines array and deletions use an empty "
            "newLines array. If a cell already has a proposal from an earlier turn, use "
            "replace_proposal with the complete desired source or discard_proposal. Only the user "
            "can Apply, Apply & Run, or Reject the resulting proposal."
        ),
        "inputSchema": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "notebookPath",
                        "expectedRevision",
                        "cellId",
                        "expectedProposalRevision",
                        "action",
                        "startLine",
                        "oldLines",
                        "newLines",
                    ],
                    "properties": {
                        "notebookPath": {"type": "string"},
                        "expectedRevision": {"type": "integer", "minimum": 0},
                        "cellId": {"type": "string"},
                        "expectedProposalRevision": {"type": "integer", "minimum": 0},
                        "action": {"const": "stage_hunk"},
                        "startLine": {"type": "integer", "minimum": 1},
                        "oldLines": {
                            "type": "array",
                            "maxItems": 400,
                            "description": (
                                "Exact current lines to remove, without newline characters."
                            ),
                            "items": {"type": "string", "pattern": "^[^\\r\\n]*$"},
                        },
                        "newLines": {
                            "type": "array",
                            "maxItems": 400,
                            "description": (
                                "Replacement lines to insert, without newline characters."
                            ),
                            "items": {"type": "string", "pattern": "^[^\\r\\n]*$"},
                        },
                    },
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "notebookPath",
                        "expectedRevision",
                        "cellId",
                        "expectedProposalRevision",
                        "action",
                        "source",
                    ],
                    "properties": {
                        "notebookPath": {"type": "string"},
                        "expectedRevision": {"type": "integer", "minimum": 0},
                        "cellId": {"type": "string"},
                        "expectedProposalRevision": {"type": "integer", "minimum": 0},
                        "action": {"const": "replace_proposal"},
                        "source": {"type": "string"},
                    },
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "notebookPath",
                        "expectedRevision",
                        "cellId",
                        "expectedProposalRevision",
                        "action",
                    ],
                    "properties": {
                        "notebookPath": {"type": "string"},
                        "expectedRevision": {"type": "integer", "minimum": 0},
                        "cellId": {"type": "string"},
                        "expectedProposalRevision": {"type": "integer", "minimum": 0},
                        "action": {"const": "discard_proposal"},
                    },
                },
            ]
        },
    },
    {
        "type": "function",
        "name": "zbook_notebook_apply",
        "description": (
            "Atomically apply structural notebook operations and save the result. Existing-cell "
            "source edits must use zbook_notebook_propose so the user can review them before they "
            "are saved. Always read first, lock every existing cell affected by a structural "
            "operation, and pass the exact notebookPath and documentRevision. Operations run in "
            "order and the whole batch is rejected on missing locks, a pending cell proposal, "
            "invalid input, or a concurrent UI change. replace_source remains in the schema only "
            "to give older threads a structured migration error and must not be used."
        ),
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["notebookPath", "expectedRevision", "operations"],
            "properties": {
                "notebookPath": {"type": "string"},
                "expectedRevision": {"type": "integer", "minimum": 0},
                "operations": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 100,
                    "items": {
                        "oneOf": [
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["op", "cellId", "source"],
                                "properties": {
                                    "op": {"const": "replace_source"},
                                    "cellId": {"type": "string"},
                                    "source": {"type": "string"},
                                },
                            },
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["op", "cellId", "cellType"],
                                "properties": {
                                    "op": {"const": "set_kind"},
                                    "cellId": {"type": "string"},
                                    "cellType": {"enum": ["code", "markdown", "raw"]},
                                },
                            },
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["op", "afterCellId", "cellType", "source"],
                                "properties": {
                                    "op": {"const": "insert_after"},
                                    "afterCellId": {"type": ["string", "null"]},
                                    "cellType": {"enum": ["code", "markdown", "raw"]},
                                    "source": {"type": "string"},
                                },
                            },
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["op", "cellId"],
                                "properties": {
                                    "op": {"const": "delete"},
                                    "cellId": {"type": "string"},
                                },
                            },
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "description": (
                                    "Move cellId immediately after afterCellId. A null "
                                    "afterCellId moves it to the beginning."
                                ),
                                "required": ["op", "cellId", "afterCellId"],
                                "properties": {
                                    "op": {"const": "move_after"},
                                    "cellId": {"type": "string"},
                                    "afterCellId": {"type": ["string", "null"]},
                                },
                            },
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "description": (
                                    "Exchange the positions of two cells without changing either "
                                    "cell's content, outputs, or metadata."
                                ),
                                "required": ["op", "cellId", "otherCellId"],
                                "properties": {
                                    "op": {"const": "swap"},
                                    "cellId": {"type": "string"},
                                    "otherCellId": {"type": "string"},
                                },
                            },
                        ]
                    },
                },
            },
        },
    },
]


def encode_message(message: dict[str, Any]) -> bytes:
    """App Server uses newline-delimited JSON-RPC messages without `jsonrpc`."""
    if "jsonrpc" in message:
        raise CodexProtocolError("Codex App Server messages must omit the jsonrpc field")
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"


class CodexAppServer:
    def __init__(self, workspace: Path, executable: str = "codex") -> None:
        self.workspace = workspace.resolve()
        self.executable = executable
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._request_id = 0
        self._write_lock = asyncio.Lock()
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._events: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._stderr: asyncio.Queue[str] = asyncio.Queue(maxsize=200)

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def start(self) -> None:
        if self.running:
            return
        self._events = asyncio.Queue()
        try:
            self._process = await asyncio.create_subprocess_exec(
                self.executable,
                "app-server",
                cwd=self.workspace,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, PermissionError) as error:
            raise CodexUnavailable(f"Cannot start {self.executable!r}: {error}") from error

        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        try:
            await self.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "zbook",
                        "title": "Zbook",
                        "version": "0.1.0",
                    },
                    "capabilities": {"experimentalApi": True},
                },
                request_timeout=15,
            )
            await self.notify("initialized")
        except Exception:
            await self.close()
            raise

    async def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> Any:
        if not self.running or self._process is None:
            raise CodexUnavailable("Codex App Server is not running")
        self._request_id += 1
        request_id = self._request_id
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        message: dict[str, Any] = {"method": method, "id": request_id}
        if params is not None:
            message["params"] = params
        try:
            async with asyncio.timeout(request_timeout):
                await self._write(message)
                return await future
        except TimeoutError as error:
            raise CodexRequestError(f"Codex request timed out: {method}") from error
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"method": method}
        if params is not None:
            message["params"] = params
        await self._write(message)

    async def respond(self, request_id: int | str, result: Any) -> None:
        await self._write({"id": request_id, "result": result})

    async def account(self) -> Any:
        return await self.request("account/read", {"refreshToken": False})

    async def models(self) -> Any:
        return await self.request("model/list", {"limit": 100, "includeHidden": False})

    async def rate_limits(self) -> Any:
        return await self.request("account/rateLimits/read")

    async def start_chatgpt_login(self) -> Any:
        return await self.request("account/login/start", {"type": "chatgpt"})

    async def logout(self) -> Any:
        return await self.request("account/logout")

    def _thread_params(self, model: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {
            "cwd": str(self.workspace),
            "approvalPolicy": "on-request",
            "sandbox": "workspace-write",
            "serviceName": "zbook",
            "developerInstructions": NOTEBOOK_TOOL_INSTRUCTIONS,
            "dynamicTools": NOTEBOOK_DYNAMIC_TOOLS,
        }
        if model:
            params["model"] = model
        return params

    async def start_thread(self, model: str | None = None) -> Any:
        params = self._thread_params(model)
        params["ephemeral"] = False
        return await self.request(
            "thread/start",
            params,
        )

    async def resume_thread(self, thread_id: str, model: str | None = None) -> Any:
        params = self._thread_params(model)
        params["threadId"] = thread_id
        return await self.request("thread/resume", params)

    async def read_thread(self, thread_id: str) -> Any:
        return await self.request(
            "thread/read",
            {"threadId": thread_id, "includeTurns": True},
        )

    async def start_turn(
        self,
        thread_id: str,
        prompt: str,
        *,
        model: str | None = None,
        effort: str | None = None,
    ) -> Any:
        if not prompt.strip():
            raise ValueError("Prompt cannot be empty")
        params: dict[str, Any] = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": prompt}],
        }
        if model:
            params["model"] = model
        if effort:
            params["effort"] = effort
        return await self.request(
            "turn/start",
            params,
        )

    async def interrupt_turn(self, thread_id: str, turn_id: str) -> Any:
        return await self.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def _write(self, message: dict[str, Any]) -> None:
        if not self.running or self._process is None or self._process.stdin is None:
            raise CodexUnavailable("Codex App Server is not running")
        async with self._write_lock:
            self._process.stdin.write(encode_message(message))
            await self._process.stdin.drain()

    async def _read_stdout(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        try:
            async for raw_line in self._process.stdout:
                try:
                    message = json.loads(raw_line)
                except json.JSONDecodeError as error:
                    await self._events.put(
                        {
                            "method": "client/protocolError",
                            "params": {"message": str(error)},
                        }
                    )
                    continue
                await self._dispatch(message)
        finally:
            error = CodexUnavailable("Codex App Server stopped")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
            await self._events.put(None)

    async def _dispatch(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if request_id is not None and "method" not in message:
            future = self._pending.get(request_id)
            if future is None or future.done():
                return
            if "error" in message:
                future.set_exception(CodexRequestError(str(message["error"])))
            else:
                future.set_result(message.get("result"))
            return
        await self._events.put(message)

    async def _read_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        async for raw_line in self._process.stderr:
            line = raw_line.decode(errors="replace").rstrip()
            if self._stderr.full():
                self._stderr.get_nowait()
            self._stderr.put_nowait(line)

    async def close(self) -> None:
        process = self._process
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
            with contextlib.suppress(BrokenPipeError):
                await process.stdin.wait_closed()
        if process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except TimeoutError:
                process.terminate()
                with contextlib.suppress(ProcessLookupError):
                    await process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        self._process = None
