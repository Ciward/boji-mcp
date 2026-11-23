import React, { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { errorMessage } from '../api';

export type IconName = 'bowl' | 'diary' | 'trend' | 'source' | 'trash' | 'plus' | 'chevron-left' | 'chevron-right' | 'close' | 'check' | 'logout' | 'download' | 'edit' | 'history' | 'restore' | 'sun' | 'moon' | 'leaf' | 'lock' | 'upload' | 'copy' | 'refresh';
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    bowl: <><path d="M3 11h18c-.7 6-4 9-9 9s-8.3-3-9-9Z" /><path d="M8 6c-2-2 2-2 0-4M13 7c-2-2 2-2 0-4M18 7l3-5M9 22h6" /></>,
    diary: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 3v18M12 8h4M12 12h4" /></>,
    trend: <><path d="M4 4v16h17M7 15l4-5 4 2 5-7" /></>,
    source: <><rect x="7" y="2" width="10" height="20" rx="3" /><path d="M10 18h4M10 7h4M12 5v4" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    'chevron-left': <path d="m14 6-6 6 6 6" />,
    'chevron-right': <path d="m10 6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    logout: <><path d="M10 4H4v16h6M9 12h12m-5-5 5 5-5 5" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6ZM12 20h9" /></>,
    history: <><path d="M4 11a8 8 0 1 1 2 7M4 4v7h7M12 7v6l3 2" /></>,
    restore: <><path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12h-4" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1" /></>,
    moon: <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" />,
    leaf: <><path d="M20 3C9 2 3 7 5 14s13 7 15-11ZM5 21l9-12" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
    refresh: <><path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Brand({ large = false }: { large?: boolean }) {
  return <div className={`brand ${large ? 'brand-large' : ''}`}><span className="brand-mark"><Icon name="bowl" size={large ? 35 : 26} /></span><span>boji<span className="brand-dot">.</span></span></div>;
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-notice" role="alert"><span>{message}</span>{onRetry && <button type="button" className="text-button" onClick={onRetry}>重新加载</button>}</div>;
}

export function EmptyState({ title, children, action, icon = 'bowl' }: { title: string; children: ReactNode; action?: ReactNode; icon?: IconName }) {
  return <div className="empty-state"><div className="empty-symbol"><Icon name={icon} size={36} /></div><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function Loading({ text = '正在读取记录…' }: { text?: string }) {
  return <div className="loading" role="status"><span className="spinner" />{text}</div>;
}

export function Modal({ title, children, onClose, wide = false, busy = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const node = ref.current;
    const before = document.activeElement as HTMLElement | null;
    node?.showModal();
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { node?.close(); document.body.style.overflow = scroll; before?.focus(); };
  }, []);
  return <dialog className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="modal-header"><h2 id={headingId}>{title}</h2><button type="button" className="icon-button" aria-label="收起面板" disabled={busy} onClick={onClose}><Icon name="close" /></button></header>
    {children}
  </dialog>;
}

export function useRemote<T>(load: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: enabled, error: null });
  const [retryCount, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (!enabled) { setState({ data: null, loading: false, error: null }); return; }
    setState({ data: null, loading: true, error: null });
    load(controller.signal).then((data) => {
      if (!controller.signal.aborted) setState({ data, loading: false, error: null });
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ data: null, loading: false, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [load, enabled, retryCount]);
  return { ...state, retry: () => retry((value) => value + 1) };
}
