"""Per-request callbacks supplied by the SuperWagie worker."""
from contextvars import ContextVar
current_host = ContextVar('hy_current_host')
current_context = ContextVar('hy_current_context')
