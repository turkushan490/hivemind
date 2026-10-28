"""Small client for HiveMind's OpenAI-compatible API (/v1)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import aiohttp

from .const import RUN_TIMEOUT


class HiveMindError(Exception):
    """HiveMind could not be reached or answered with an error."""


class HiveMindAuthError(HiveMindError):
    """The API token was refused."""


@dataclass
class Canvas:
    """A saved canvas, offered by HiveMind as a model."""

    id: str
    name: str


def normalize_url(url: str) -> str:
    """http://host:4820/ or http://host:4820/v1 -> http://host:4820."""
    url = url.strip().rstrip("/")
    if url.endswith("/v1"):
        url = url[:-3]
    if not url.startswith(("http://", "https://")):
        url = f"http://{url}"
    return url


class HiveMindClient:
    """Talks to one HiveMind server with one API token."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        self._session = session
        self.url = normalize_url(url)
        self._headers = {"Authorization": f"Bearer {token.strip()}"}

    async def _request(self, method: str, path: str, timeout: float, **kwargs: Any) -> Any:
        try:
            async with self._session.request(
                method,
                f"{self.url}{path}",
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=timeout),
                **kwargs,
            ) as resp:
                if resp.status == 401:
                    raise HiveMindAuthError("HiveMind refused the API token")
                try:
                    data = await resp.json(content_type=None)
                except ValueError as err:
                    # An HTML error page (e.g. a reverse proxy's 502) is not "not HiveMind".
                    if resp.status >= 400:
                        raise HiveMindError(f"{self.url} answered HTTP {resp.status}") from err
                    raise HiveMindError(f"{self.url} does not look like a HiveMind server") from err
                if resp.status >= 400:
                    message = data.get("error") if isinstance(data, dict) else None
                    if isinstance(message, dict):
                        message = message.get("message")
                    raise HiveMindError(str(message) if message else f"HiveMind answered HTTP {resp.status}")
                if not isinstance(data, dict):
                    raise HiveMindError(f"{self.url} does not look like a HiveMind server")
                return data
        except asyncio.TimeoutError as err:
            raise HiveMindError(f"HiveMind did not answer within {int(timeout)} seconds") from err
        except aiohttp.ClientError as err:
            raise HiveMindError(f"Cannot reach HiveMind at {self.url}: {err}") from err

    async def canvases(self) -> list[Canvas]:
        """All saved canvases of the token's user."""
        data = await self._request("GET", "/v1/models", 20)
        models = data.get("data")
        if not isinstance(models, list):
            raise HiveMindError(f"{self.url} does not look like a HiveMind server")
        return [Canvas(id=m["id"], name=m.get("name") or m["id"]) for m in models if isinstance(m, dict) and m.get("id")]

    async def run(self, canvas: str, text: str, history: list[dict[str, str]] | None = None) -> str:
        """Runs a canvas with the text as its question (earlier turns as history); returns the final answer."""
        data = await self._request(
            "POST",
            "/v1/chat/completions",
            RUN_TIMEOUT,
            json={"model": canvas, "messages": [*(history or []), {"role": "user", "content": text}]},
        )
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as err:
            raise HiveMindError("HiveMind sent an answer in an unexpected format") from err
