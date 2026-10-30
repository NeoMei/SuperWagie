"""SuperWagie adaptation. All model calls use the authorized Node host."""
from dataclasses import dataclass
from enum import Enum
from ..host_bridge import current_host, current_context

class LLMBackend(Enum):
    OPENAI = 'host'

@dataclass
class LLMConfig:
    temperature: float = 0.0

@dataclass
class LLMResponse:
    content: str
    tokens_used: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str = ''
    finish_reason: str = ''
    response_id: str = ''
    choices_count: int = 1
    reasoning_content: str = ''
    reasoning_tokens: int = 0
    tool_calls: list = None

class LLMProvider:
    def __init__(self, config=None):
        self.config = config
        self.llm_config = config.llm if config else LLMConfig()
    async def complete(self, prompt, system_prompt=None, max_tokens=4000, audit_stage=None, **kwargs):
        ctx = current_context.get()
        result = await current_host.get()('host.generate', {
            'jobId': ctx['jobId'], 'prompt': prompt, 'systemPrompt': system_prompt,
            'maxTokens': min(max_tokens, 12000), 'auditStage': audit_stage or 'hy',
            'modelPreference': ctx.get('modelPreference'), 'onOverflow': 'error',
        })
        if result.get('inputTruncated') or result.get('finish_reason') == 'length':
            raise ValueError('hy_model_output_truncated')
        text = result.get('content', result.get('text'))
        if not isinstance(text, str) or len(text) > 150000:
            raise ValueError('hy_model_output_invalid')
        return LLMResponse(content=text, tokens_used=result.get('tokens_used', 0),
                           prompt_tokens=result.get('prompt_tokens', 0),
                           completion_tokens=result.get('completion_tokens', 0),
                           finish_reason=result.get('finish_reason', 'stop'))
    async def complete_messages(self, messages, max_tokens=4000, **kwargs):
        system = '\n\n'.join(m.get('content', '') for m in messages if m.get('role') == 'system')
        prompt = '\n\n'.join(m.get('content', '') for m in messages if m.get('role') != 'system')
        return await self.complete(prompt, system_prompt=system, max_tokens=max_tokens, **kwargs)
    async def close(self):
        pass
    def get_stats(self):
        return {}

def _content_fingerprint(value):
    import hashlib
    return hashlib.sha256((value or '').encode()).hexdigest()[:16]

def _log_llm_content_enabled():
    return False
