export const PYTHON_RUNTIME = String.raw`
from __future__ import annotations
import json
import urllib.error
import urllib.parse
import urllib.request
from types import NoneType
from typing import Any, Callable, Iterator, Mapping, TypedDict, TypeVar, Union, cast
JsonValue = Union[None, bool, int, float, str, list['JsonValue'], dict[str, 'JsonValue']]
_UNSET = object()
T = TypeVar('T')
O = TypeVar('O')
class RequestContext(TypedDict):
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None
class ApiError(Exception):
    def __init__(self, kind: str, message: str, *, status: int | None = None, body: JsonValue = None, cause: Exception | None = None):
        super().__init__(message)
        self.kind, self.status, self.body, self.cause = kind, status, body, cause
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
class Client:
    def __init__(self, base_url: str, *, headers: Mapping[str, str] | None = None, auth: Callable[[RequestContext], None] | None = None, on_error: Callable[[ApiError, RequestContext], None] | None = None, timeout: float = 30, transport: Callable[..., Any] | None = None):
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('base_url must be an HTTP(S) URL without credentials, query or fragment')
        if not 0 < timeout < float('inf'):
            raise ValueError('timeout must be finite and positive')
        self.base_url, self.headers = base_url.rstrip('/'), dict(headers or {})
        self.auth, self.on_error, self.timeout = auth, on_error, timeout
        self.transport = transport or urllib.request.build_opener(_NoRedirect()).open
    def request(self, operation: str, *, path: Mapping[str, str | int | float] | None = None, query: Mapping[str, Any] | None = None, body: Any = _UNSET, headers: Mapping[str, str] | None = None) -> JsonValue:
        import re
        descriptor = OPERATIONS[operation]
        def substitute(match):
            key = match.group(1)
            value = (path or {}).get(key)
            if value is None or str(value) in ('', '.', '..') or '{{' in str(value):
                raise ValueError('Missing or unresolved path parameter: ' + key)
            return urllib.parse.quote(str(value), safe='')
        endpoint = re.sub(r'\{([^{}]+)\}', substitute, descriptor['path'])
        parameters = [(key, str(item).lower() if isinstance(item, bool) else str(item)) for key, value in (query or {}).items() if value is not None for item in (value if isinstance(value, (list, tuple)) else [value])]
        url = self.base_url + endpoint + ('?' + urllib.parse.urlencode(parameters) if parameters else '')
        sent_headers = {**self.headers, **(headers or {})}
        data = None
        if body is not _UNSET:
            mode = descriptor['bodyMode']
            if mode == 'json':
                data = json.dumps(body, separators=(',', ':')).encode('utf-8')
                if not any(key.lower() == 'content-type' for key in sent_headers): sent_headers['Content-Type'] = 'application/json'
            elif mode == 'urlencoded':
                data = urllib.parse.urlencode(body, doseq=True).encode('utf-8')
                sent_headers['Content-Type'] = 'application/x-www-form-urlencoded'
            else:
                data = str(body).encode('utf-8')
        context: RequestContext = {'method': descriptor['method'], 'url': url, 'headers': sent_headers, 'body': data}
        try:
            if self.auth: self.auth(context)
            request = urllib.request.Request(context['url'], data=context['body'], headers=context['headers'], method=context['method'])
            try:
                response = self.transport(request, timeout=self.timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.status
                text = response.read().decode('utf-8')
                value: JsonValue = text or None
                if text and 'json' in response.headers.get('content-type', '').lower():
                    try: value = json.loads(text)
                    except ValueError as error: raise ApiError('decode', 'Response is not valid JSON', status=status, cause=error) from error
                if not 200 <= status < 300: raise ApiError('http', 'HTTP ' + str(status), status=status, body=value)
                return value
        except Exception as error:
            failure = error if isinstance(error, ApiError) else ApiError('network', 'Request failed', cause=error)
            if self.on_error: self.on_error(failure, context)
            raise failure
    def pages(self, operation: Callable[[O], T], initial: O, next_page: Callable[[T, O, int], O | None], max_pages: int = 100) -> Iterator[T]:
        if not isinstance(max_pages, int) or not 1 <= max_pages <= 10000: raise ValueError('max_pages must be between 1 and 10000')
        options = initial
        for index in range(max_pages):
            value = operation(options)
            yield value
            following = next_page(value, options, index)
            if following is None: return
            options = following
        raise ApiError('pagination', 'Pagination exceeded max_pages')
`;
