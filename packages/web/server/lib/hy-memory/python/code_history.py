"""Hy code-version decoration over a bounded, host-authorized patch selection."""
import sqlite3
from hy_memory.coding.chain_store import HyCodeMem, _SCHEMA
from adapters import digest


def parser_for(context):
    parser = HyCodeMem.__new__(HyCodeMem)
    parser.repo = None
    parser.dir = ''
    parser.owner = digest([context['userId'], context['agentId'], context['projectId']])
    parser._commit_cache = {}
    # The persistent store belongs to Node. This scratch graph executes Hy's
    # version grouping and renderer without reading source files or running git.
    parser.db = sqlite3.connect(':memory:')
    parser.db.executescript(_SCHEMA)
    return parser


def decorate_history(records, query, facts, context):
    parser = parser_for(context)
    try:
        for record in sorted(records, key=lambda r: (r.get('created_at', 0), r.get('message_id', ''), r.get('id', ''))):
            if record.get('project_id') != context['projectId']:
                continue
            patch = record.get('patch', '')
            if not patch:
                continue
            identity = parser._upsert_thread(record.get('branch') or '', record.get('file') or '',
                           record.get('symbol') or '', record.get('line_start') or 0,
                           record.get('line_end') or 0)
            said = record.get('said', '') + '\n[source ' + record.get('session_id', '') + '/' + record.get('message_id', '') + ']'
            parser._add_round(identity, said, patch, at=record.get('created_at'))
        parser.db.commit()
        decorated, metadata = parser.decorate(facts, query)
        return {'text': decorated, 'metadata': metadata, 'records': records}
    finally:
        parser.db.close()
