#!/usr/bin/env python3
"""Tiny JSONL peer used to exercise Zbook's real subprocess transport."""

from __future__ import annotations

import json
import sys
from typing import Any


def send(message: dict[str, Any]) -> None:
    print(json.dumps(message, separators=(",", ":")), flush=True)


for raw_line in sys.stdin:
    message = json.loads(raw_line)
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialized" or request_id is None:
        continue

    if method == "initialize":
        client_info = message.get("params", {}).get("clientInfo", {})
        send({"method": "fake/initialized", "params": {"clientInfo": client_info}})
        result: Any = {"serverInfo": {"name": "fake-codex"}}
    elif method == "account/read":
        result = {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": False}
    elif method == "thread/start":
        result = {"thread": {"id": "thread-integration"}}
    elif method == "turn/start":
        send(
            {
                "method": "fake/turnStarted",
                "params": {
                    "threadId": message["params"]["threadId"],
                    "text": message["params"]["input"][0]["text"],
                },
            }
        )
        result = {"turn": {"id": "turn-integration"}}
    elif method == "fake/error":
        send({"id": request_id, "error": {"message": "intentional failure"}})
        continue
    else:
        result = {}

    send({"id": request_id, "result": result})
