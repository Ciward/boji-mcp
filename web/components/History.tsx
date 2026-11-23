import React, { useCallback } from 'react';
import { prettyInstant } from '../model';
import type { Api, Meal, Revision } from '../types';
import { MealSnapshot } from './MealEditor';
import { EmptyState, ErrorNotice, Loading, Modal, useRemote } from './ui';

const operations: Record<string, string> = { create: '创建记录', created: '创建记录', update: '修正记录', updated: '修正记录', delete: '移入回收站', deleted: '移入回收站', restore: '恢复记录', restored: '恢复记录' };
export default function History({ meal, timezone, api, onClose }: { meal: Meal; timezone: string; api: Api; onClose: () => void }) {
  const load = useCallback((signal: AbortSignal) => api<{ items: Revision[] }>(`/meals/${encodeURIComponent(meal.id)}/history`, { signal }), [api, meal.id]);
  const history = useRemote(load);
  return <Modal title="每一次修正，都有迹可循" onClose={onClose}>
    <div className="modal-body"><p className="history-title">{meal.title}</p><p className="muted">历史版本用于查看；当前记录以最新版本为准。</p>
      {history.loading && <Loading />}{history.error && <ErrorNotice message={history.error} onRetry={history.retry} />}
      {history.data && !history.data.items.length && <EmptyState title="暂时没有历史记录" icon="history">可以稍后重新读取。</EmptyState>}
      {history.data && <div className="history-list">{[...history.data.items].sort((a, b) => b.version - a.version).map((revision, index) => <details className="history-entry" key={revision.version} open={index === 0}>
        <summary><span className="version-dot">{revision.version}</span><span><strong>{operations[revision.operation] || revision.operation}</strong><small>{prettyInstant(revision.created_at, timezone)}</small></span><span className="pill">v{revision.version}</span></summary>
        <div className="history-content"><h3>{revision.snapshot.title}</h3><MealSnapshot meal={revision.snapshot} timezone={timezone} /></div>
      </details>)}</div>}
    </div>
  </Modal>;
}
