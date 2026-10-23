"""Shared loading and validation for provider API keys."""

import os
import json
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional, Sequence


class APIKeyError(ValueError):
    """Raised when a configured provider key is unsafe for an HTTP header."""


def load_api_key(environment_name: str, secret_path: Path) -> str:
    """Load an environment key first, then a newline-terminated secret file."""
    environment_value = os.environ.get(environment_name)
    if environment_value is not None and environment_value != "":
        return environment_value
    try:
        return secret_path.read_text(encoding="utf-8").rstrip("\r\n")
    except (OSError, UnicodeError):
        return ""


def validate_api_key(value: object) -> str:
    """Return a header-safe key without ever including it in an error."""
    if (
        not isinstance(value, str)
        or not value
        or not value.isascii()
        or not value.isprintable()
        or any(character.isspace() for character in value)
    ):
        raise APIKeyError(
            "configured API key is invalid; use non-empty printable ASCII "
            "without whitespace"
        )
    return value


def load_model_binding(purpose: str, supported_protocols: Sequence[str]) -> Optional[dict]:
    """Resolve one configured purpose privately; stdout contains server-only credentials."""
    resolver = os.environ.get("SUPERWAGIE_MODEL_RESOLVER")
    if not resolver:
        data_dir = Path(os.environ.get("OPENCHAMBER_DATA_DIR", "~/.config/openchamber")).expanduser()
        if (data_dir / "model-configuration.json").exists():
            raise APIKeyError("unified model runtime is unavailable; run this skill from SuperWagie")
        return None
    try:
        result = subprocess.run(
            [os.environ.get("SUPERWAGIE_MODEL_NODE", "node"), resolver, purpose, *supported_protocols],
            capture_output=True, text=True, timeout=20,
            env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"}, check=False,
        )
        if result.returncode != 0:
            raise APIKeyError("the selected model binding is unavailable or unsupported; check Model configuration")
        binding = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise APIKeyError("unable to resolve the unified model configuration") from error
    if binding is None:
        return None
    if not isinstance(binding, dict) or binding.get("protocol") not in supported_protocols or not isinstance(binding.get("baseUrl"), str) or not isinstance(binding.get("model"), str):
        raise APIKeyError("invalid unified model configuration response")
    validate_api_key(binding.get("apiKey"))
    return binding


def configured_image_binding(engine: str) -> Optional[dict]:
    binding = load_model_binding("image-generation", ("openai-compatible", "aliyun", "gemini", "volcengine"))
    if binding is None:
        return None
    expected = {"openai-compatible": "openai", "aliyun": "openai", "gemini": "gemini", "volcengine": "doubao"}[binding["protocol"]]
    if engine != expected:
        raise APIKeyError("the requested image adapter differs from the selected model; use the configured provider")
    return binding


def image_endpoint(binding: dict, engine: str) -> str:
    base_url = binding["baseUrl"].rstrip("/")
    if binding["protocol"] == "aliyun":
        base_url = base_url.split("/compatible-mode/v1", 1)[0].split("/api/v1", 1)[0] + "/compatible-mode/v1"
    if engine == "gemini":
        from urllib.parse import quote
        return base_url + "/models/" + quote(binding["model"], safe="") + ":generateContent"
    return base_url + "/images/generations"


class ProviderRedirectError(urllib.error.URLError):
    """Authenticated requests must not cross a redirect or forward credentials."""

    def __init__(self):
        super().__init__("provider redirects are not supported")


class _RefuseProviderRedirects(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, request, response, status, message, headers):
        try:
            response.close()
        finally:
            raise ProviderRedirectError()

    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302
    http_error_308 = http_error_302


def open_provider_request(request: urllib.request.Request, timeout: int):
    """Open only the configured endpoint; never forward keys through redirects."""
    return urllib.request.build_opener(_RefuseProviderRedirects()).open(request, timeout=timeout)
