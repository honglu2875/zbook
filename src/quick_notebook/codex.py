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
        await self.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "quick-notebook",
                    "title": "Quick Notebook",
                    "version": "0.1.0",
                },
                "capabilities": {"experimentalApi": True},
            },
        )
        await self.notify("initialized")

    async def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        if not self.running or self._process is None:
            raise CodexUnavailable("Codex App Server is not running")
        self._request_id += 1
        request_id = self._request_id
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self._write({"method": method, "id": request_id, "params": params or {}})
        try:
            return await future
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        await self._write({"method": method, "params": params or {}})

    async def respond(self, request_id: int | str, result: Any) -> None:
        await self._write({"id": request_id, "result": result})

    async def account(self) -> Any:
        return await self.request("account/read", {"refreshToken": False})

    async def start_chatgpt_login(self) -> Any:
        return await self.request("account/login/start", {"type": "chatgpt"})

    async def start_thread(self) -> Any:
        return await self.request(
            "thread/start",
            {
                "cwd": str(self.workspace),
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
            },
        )

    async def start_turn(self, thread_id: str, prompt: str) -> Any:
        if not prompt.strip():
            raise ValueError("Prompt cannot be empty")
        return await self.request(
            "turn/start",
            {"threadId": thread_id, "input": [{"type": "text", "text": prompt}]},
        )

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
