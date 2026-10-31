"""Bounded inline wire format shared by long-form planners and native writers."""
from __future__ import annotations
from dataclasses import replace


def span_format(span):
    values = {key: True for key in ('bold', 'italic', 'code', 'strikethrough') if getattr(span, key, False)}
    if span.link:
        values['link'] = span.link
    if span.link_title:
        values['linkTitle'] = span.link_title
    if span.role:
        values['role'] = span.role
    return values


def span_values(spans):
    return [{'text': span.text, **span_format(span)} for span in spans]


def rich_span_values(spans):
    return span_values(spans) if any(span_format(span) for span in spans) else None


def slice_spans(spans, start, length=None):
    """Slice by Python visible-text positions without losing semantic attributes."""
    result = []
    for span in spans:
        if start >= len(span.text):
            start -= len(span.text)
        else:
            text = span.text[start:]
            if length is not None:
                text = text[:length]
                length -= len(text)
            if text:
                result.append(replace(span, text=text))
            start = 0
            if length == 0:
                break
    return result


def utf16_length(text):
    return len(text.encode('utf-16-le')) // 2
