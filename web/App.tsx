import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, request } from './api';
import { createSaveKeys, dateTimeLocal, makeDraft, prettyDate, shiftDate } from './model';
import type { Api, Context, Meal, MealDraft, MealInput, PersistedMeal, Session, Summary, Trend } from './types';
import MealEditor from './components/MealEditor';
import History from './components/History';
import Sources from './components/Sources';
import FoodLibrary from './components/FoodLibrary';
import { HealthSummary, MealCard, NoMeals, Overview, WeekChart } from './components/Diary';
import { Brand, ErrorNotice, Icon, Loading, Modal, useRemote } from './components/ui';
import type { IconName } from './components/ui';

type Page = 'diary' | 'trends' | 'sources' | 'recycle' | 'foods';
const pages: { id: Page; title: string; icon: IconName }[] = [
  { id: 'diary', title: '饮食日记', icon: 'diary' }, { id: 'trends', title: '七日趋势', icon: 'trend' },
  { id: 'foods', title: '食物库', icon: 'leaf' },
  { id: 'sources', title: '数据源', icon: 'source' }, { id: 'recycle', title: '回收站', icon: 'trash' },
];

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [authMessage, setAuthMessage] = useState('');
  const [context, setContext] = useState<Context | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [page, setPage] = useState<Page>('diary');
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<MealDraft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [historyMeal, setHistoryMeal] = useState<Meal | null>(null);
  const [deleteMeal, setDeleteMeal] = useState<Meal | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const mutationLock = useRef(false);
  const [toast, setToast] = useState<{ text: string; undo?: Meal } | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [foodReset, setFoodReset] = useState(0);
  const [sourcesVisited, setSourcesVisited] = useState(false);
  const keys = useRef(createSaveKeys());
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  const authenticated = Boolean(session);

  useEffect(() => {
    const controller = new AbortController();
    setBootError(null);
    request<Session>('/session', null, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) {
        if (!value?.authenticated || !value.csrf_token) throw new Error('登录会话响应不完整，请重新登录。');
        setSession(value);
      }
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) setSession(null);
      else setBootError(errorMessage(error));
    });
    return () => controller.abort();
  }, [bootAttempt]);

  const csrf = session?.csrf_token || null;
  const api: Api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    try { return await request<T>(path, csrf, init); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSession(null); setAuthMessage('登录已过期。重新登录后可以继续，当前餐食和食物库草稿仍保留。');
      }
      throw error;
    }
  }, [csrf]);

  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    setContextError(null);
    api<Context>('/context', { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      if (!value.today || !value.timezone) throw new Error('个人日期与时区信息不完整，请重新加载。');
      setContext(value); setDate((previous) => previous || value.today);
    }).catch((error) => { if (!controller.signal.aborted) setContextError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, authenticated, revision]);

  useEffect(() => {
    if (!draft) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [draft]);

  const deleted = page === 'recycle';
  const loadMeals = useCallback(async (signal: AbortSignal) => {
    void revision;
    const items: Meal[] = [];
    let total = 0;
    do {
      const result = await api<{ items: Meal[]; total: number }>(`/meals?date=${encodeURIComponent(date)}&deleted=${deleted}&limit=100&offset=${items.length}`, { signal });
      total = result.total;
      if (!result.items.length && items.length < total) throw new Error('餐食列表尚未完整返回，请重新加载。');
      if (result.items.some((meal) => items.some((existing) => existing.id === meal.id))) throw new Error('餐食列表在读取中发生变化，请重新加载。');
      items.push(...result.items);
    } while (items.length < total);
    return { items, total };
  }, [api, date, deleted, revision]);
  const meals = useRemote(loadMeals, authenticated && Boolean(date) && (page === 'diary' || deleted));
  const loadSummary = useCallback((signal: AbortSignal) => { void revision; return api<Summary>(`/summary?date=${encodeURIComponent(date)}`, { signal }); }, [api, date, revision]);
  const summary = useRemote(loadSummary, authenticated && Boolean(date) && page === 'diary');
  const loadTrends = useCallback((signal: AbortSignal) => { void revision; return api<{ items: Trend[] }>('/trends?days=7', { signal }); }, [api, revision]);
  const trends = useRemote(loadTrends, authenticated && (page === 'diary' || page === 'trends'));

  function navigate(next: Page) {
    setPage(next); setMutationError(null);
    if (next === 'sources') setSourcesVisited(true);
  }
  function beginMeal(meal?: Meal) {
    if (!context) return;
    if (draft) {
      setEditorOpen(true);
      if (draft.original?.id !== meal?.id) setToast({ text: '已打开尚未完成的草稿。保存或放弃后，再编辑另一顿餐食。' });
      return;
    }
    setDraft(makeDraft(date, context.timezone, meal)); setEditorOpen(true);
  }
  function requirePersisted(result: PersistedMeal) {
    if (result?.persisted !== true || !result.meal?.id || !Number.isInteger(result.meal.version)) throw new Error('未收到完整的保存回执。草稿已保留，请使用相同内容重试。');
    return result.meal;
  }
  async function saveMeal(meal: MealInput, currentDraft: MealDraft) {
    const scope = currentDraft.original ? `edit:${currentDraft.original.id}` : 'new';
    const payload = { ...(currentDraft.original ? { expected_version: currentDraft.expectedVersion } : {}), meal };
    const idempotencyKey = keys.current.forPayload(scope, payload);
    const result = await api<PersistedMeal>(currentDraft.original ? `/meals/${encodeURIComponent(currentDraft.original.id)}` : '/meals', {
      method: currentDraft.original ? 'PUT' : 'POST', body: JSON.stringify({ idempotency_key: idempotencyKey, ...payload }),
    });
    const saved = requirePersisted(result);
    keys.current.complete(scope); setDraft(null); setEditorOpen(false);
    setDate(dateTimeLocal(saved.occurred_at, context!.timezone).slice(0, 10)); setPage('diary');
    setToast({ text: `「${saved.title}」已保存 · 版本 ${saved.version}` }); changed();
  }
  async function changeMealState(meal: Meal, restore: boolean) {
    if (mutationLock.current) return;
    mutationLock.current = true; setActionBusy(meal.id); setMutationError(null);
    const action = restore ? 'restore' : 'delete';
    const scope = `${action}:${meal.id}`;
    const payload = { expected_version: meal.version };
    try {
      const result = await api<PersistedMeal>(`/meals/${encodeURIComponent(meal.id)}/${action}`, {
        method: 'POST', body: JSON.stringify({ idempotency_key: keys.current.forPayload(scope, payload), ...payload }),
      });
      const saved = requirePersisted(result);
      keys.current.complete(scope); setDeleteMeal(null);
      setToast({ text: restore ? `「${saved.title}」已恢复` : `「${saved.title}」已移入回收站`, ...(restore ? {} : { undo: saved }) }); changed();
    } catch (error) {
      setMutationError(errorMessage(error));
      if (error instanceof ApiError && error.status === 409) { changed(); if (restore) setToast(null); }
    } finally { mutationLock.current = false; setActionBusy(null); }
  }
  async function logout() {
    if (logoutBusy) return;
    setLogoutBusy(true); setMutationError(null);
    try {
      await api('/logout', { method: 'POST' });
      setFoodReset((value) => value + 1); setSession(null); setContext(null); setDate(''); setDraft(null); setEditorOpen(false); setHistoryMeal(null); setDeleteMeal(null); setToast(null); setSourcesVisited(false); setLogoutOpen(false); setAuthMessage(''); setPage('diary'); keys.current = createSaveKeys();
    } catch (error) { setMutationError(errorMessage(error)); }
    finally { setLogoutBusy(false); }
  }
  async function exportData() {
    if (exportBusy) return;
    setExportBusy(true); setMutationError(null);
    try {
      const result = await api<unknown>('/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `boji-export-${context?.today || 'data'}.json`;
      document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast({ text: '已生成 JSON 导出文件。' });
    } catch (error) { setMutationError(errorMessage(error)); }
    finally { setExportBusy(false); }
  }

  if (session === undefined) return <div className="boot-screen"><Brand large />{bootError ? <ErrorNotice message={bootError} onRetry={() => setBootAttempt((value) => value + 1)} /> : <Loading text="正在打开你的健康日记…" />}</div>;
  const timezone = context?.timezone || 'UTC';
  return <>
    {!session && <Login message={authMessage} onLogin={(value) => { setSession(value); setAuthMessage(''); setMutationError(null); changed(); }} />}
    <div className="app-shell" hidden={!session}>
      <aside className="sidebar"><Brand /><p className="brand-caption">把日常，轻轻记下。</p><nav aria-label="主导航">{pages.map(({ id, title, icon }) => <button className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} key={id} onClick={() => navigate(id)}><Icon name={icon} /><span>{title}</span></button>)}</nav><div className="sidebar-bottom"><span className="profile-avatar">{context?.profile.display_name?.slice(0, 1) || '我'}</span><div><strong>{context?.profile.display_name || '我的健康日记'}</strong><small>{timezone}</small></div><button className="icon-button" aria-label="退出登录" onClick={() => setLogoutOpen(true)}><Icon name="logout" size={18} /></button></div></aside>
      <main className="main-content"><header className="mobile-header"><Brand /><button className="icon-button" aria-label="退出登录" onClick={() => setLogoutOpen(true)}><Icon name="logout" /></button></header>
        <div className="page-heading"><div><p className="greeting">{page === 'diary' ? (date === context?.today ? '今天，也照顾好自己' : '回看日常里的这一页') : page === 'trends' ? '看见每天的小变化' : page === 'foods' ? '留住常吃的味道与份量' : page === 'sources' ? '让每份数据都有来处' : '需要时，再找回来'}</p><h1>{pages.find((entry) => entry.id === page)?.title}</h1></div><div className="heading-actions"><button className="icon-button" aria-label="刷新所有数据" onClick={changed}><Icon name="refresh" /></button><button className="button secondary export-button" disabled={exportBusy || !context} onClick={exportData}><Icon name="download" size={17} /><span>{exportBusy ? '正在导出…' : '导出数据'}</span></button></div></div>
        <FoodLibrary key={foodReset} api={api} timezone={timezone} authenticated={authenticated} visible={page === 'foods'} revision={revision} />
        {contextError && <ErrorNotice message={contextError} onRetry={changed} />}
        {!context && !contextError && <Loading text="正在读取个人时区与日期…" />}
        {context && <>
          {(page === 'diary' || page === 'recycle') && <div className="date-toolbar"><div className="date-picker"><button className="icon-button" aria-label="前一天" disabled={!date} onClick={() => setDate(shiftDate(date, -1))}><Icon name="chevron-left" size={18} /></button><label className="date-label"><span className="sr-only">选择日记日期</span><input type="date" value={date} required onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label><button className="icon-button" aria-label="后一天" disabled={!date} onClick={() => setDate(shiftDate(date, 1))}><Icon name="chevron-right" size={18} /></button>{date !== context.today && <button className="text-button today-button" onClick={() => setDate(context.today)}>今天</button>}</div><span className="date-weekday">{date && prettyDate(date, { weekday: 'long' })}</span><span className="timezone-label">{timezone}</span></div>}
          {draft && !editorOpen && <div className="draft-banner"><div><Icon name="edit" size={18} /><span>有一份未保存的餐食草稿</span></div><button className="text-button" onClick={() => setEditorOpen(true)}>继续编辑</button></div>}
          {mutationError && !deleteMeal && !logoutOpen && <ErrorNotice message={mutationError} onRetry={changed} />}
          {page === 'diary' && <div className="diary-layout"><div className="diary-column">{summary.loading && <Loading text="正在读取营养概览…" />}{summary.error && <ErrorNotice message={summary.error} onRetry={summary.retry} />}{summary.data && <Overview summary={summary.data} />}
            <section className="meals-section"><div className="section-heading"><div><h2>这一页的餐食</h2><p>每一顿，都是生活的一部分。</p></div><button className="button primary" onClick={() => beginMeal()}><Icon name="plus" size={18} />记一餐</button></div>{meals.loading && <Loading />}{meals.error && <ErrorNotice message={meals.error} onRetry={meals.retry} />}{meals.data && !meals.data.items.length && <NoMeals deleted={false} onAdd={() => beginMeal()} />}
              {meals.data?.items.map((meal) => <MealCard key={meal.id} meal={meal} timezone={timezone} deleted={false} onEdit={() => beginMeal(meal)} onHistory={() => setHistoryMeal(meal)} onDelete={() => { setMutationError(null); setDeleteMeal(meal); }} onRestore={() => changeMealState(meal, true)} pending={actionBusy === meal.id} />)}
            </section></div><aside className="diary-aside">{trends.loading && <Loading text="正在读取趋势…" />}{trends.error && <ErrorNotice message={trends.error} onRetry={trends.retry} />}{trends.data && <WeekChart items={trends.data.items} today={context.today} selected={date} onDate={setDate} />}<HealthSummary health={summary.data?.health} /><div className="quiet-note"><span className="little-bowl"><Icon name="bowl" size={24} /></span><p>不必每一项都很精确。<br />留住记录，也给修正留一点空间。</p></div></aside></div>}
          {page === 'trends' && <div className="trends-page">{trends.loading && <Loading />}{trends.error && <ErrorNotice message={trends.error} onRetry={trends.retry} />}{trends.data && <WeekChart items={trends.data.items} today={context.today} selected={date} onDate={(value) => { setDate(value); setPage('diary'); }} large />}<p className="muted trend-explanation">图表展示近七天的已记录摄入。点击某一天可回到日记；缺失记录与真实的零值分别显示。</p></div>}
          {sourcesVisited && <div hidden={page !== 'sources'}><Sources api={api} timezone={timezone} enabled={authenticated} revision={revision} onChanged={changed} /></div>}
          {page === 'recycle' && <section className="recycle-page"><div className="recycle-intro"><Icon name="restore" size={24} /><p>移除的餐食不计入营养合计。恢复后会重新计入原用餐日期，并保留版本历史。</p></div>{meals.loading && <Loading />}{meals.error && <ErrorNotice message={meals.error} onRetry={meals.retry} />}{meals.data && !meals.data.items.length && <NoMeals deleted onAdd={() => beginMeal()} />}{meals.data?.items.map((meal) => <MealCard key={meal.id} meal={meal} timezone={timezone} deleted onEdit={() => beginMeal(meal)} onHistory={() => setHistoryMeal(meal)} onDelete={() => setDeleteMeal(meal)} onRestore={() => changeMealState(meal, true)} pending={actionBusy === meal.id} />)}</section>}
          <footer className="page-footer"><span>Boji · 你的个人健康账本</span><span>未知保留为空，记录随时修正。</span></footer>
        </>}
      </main>
      <nav className="bottom-nav" aria-label="移动导航">{pages.map(({ id, title, icon }) => <button key={id} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon} size={21} /><span>{title}</span></button>)}</nav>
    </div>
    {session && toast && <div className="toast" role="status"><Icon name="check" size={18} /><span>{toast.text}</span>{toast.undo && <button className="text-button" disabled={actionBusy !== null} onClick={() => changeMealState(toast.undo!, true)}>撤销移除</button>}<button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><Icon name="close" size={17} /></button></div>}
    {session && draft && editorOpen && <MealEditor draft={draft} onChange={setDraft} onClose={() => setEditorOpen(false)} onDiscard={() => { keys.current.complete(draft.original ? `edit:${draft.original.id}` : 'new'); setDraft(null); setEditorOpen(false); }} onSave={saveMeal} api={api} />}
    {session && historyMeal && <History meal={historyMeal} timezone={timezone} api={api} onClose={() => setHistoryMeal(null)} />}
    {session && deleteMeal && <Modal title="将这顿餐食移入回收站？" onClose={() => setDeleteMeal(null)} busy={actionBusy !== null}><div className="modal-body"><p>「{deleteMeal.title}」将从已记录摄入中移除。需要时可以在回收站恢复。</p>{mutationError && <ErrorNotice message={mutationError} />}<p className="field-hint">如果记录已变化，请关闭此面板并刷新日记后重新选择。</p></div><footer className="modal-footer"><button className="button secondary" disabled={actionBusy !== null} onClick={() => setDeleteMeal(null)}>保留记录</button><button className="button danger" disabled={actionBusy !== null} onClick={() => changeMealState(deleteMeal, false)}>{actionBusy ? '正在移除…' : '移入回收站'}</button></footer></Modal>}
    {session && logoutOpen && <Modal title="退出 Boji？" onClose={() => setLogoutOpen(false)} busy={logoutBusy}><div className="modal-body"><p>退出后需要重新登录。当前未保存的餐食和食物库草稿将被清除。尚未保存的来源凭证也会从页面清除。</p>{mutationError && <ErrorNotice message={mutationError} />}</div><footer className="modal-footer"><button className="button secondary" disabled={logoutBusy} onClick={() => setLogoutOpen(false)}>继续使用</button><button className="button primary" disabled={logoutBusy} onClick={logout}>{logoutBusy ? '正在退出…' : '退出登录'}</button></footer></Modal>}
  </>;
}

function Login({ message, onLogin }: { message: string; onLogin: (session: Session) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  async function login(event: React.FormEvent) {
    event.preventDefault(); if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try {
      const result = await request<Session>('/login', null, { method: 'POST', body: JSON.stringify({ password }) });
      if (!result?.authenticated || !result.csrf_token) throw new Error('登录响应不完整，请重试。');
      setPassword(''); onLogin(result);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { lock.current = false; setPending(false); }
  }
  return <main className="login-page"><section className="login-story"><Brand large /><div className="login-illustration" aria-hidden="true"><svg viewBox="0 0 360 270" fill="none"><ellipse cx="180" cy="240" rx="104" ry="12" fill="#DFE7F2" /><path d="M65 136h230c-10 74-47 102-115 102S75 210 65 136Z" fill="#E4EDF9" /><path d="M65 136h230c-10 74-47 102-115 102S75 210 65 136Z" stroke="#426EAE" strokeWidth="3" /><ellipse cx="180" cy="136" rx="115" ry="24" fill="#fff" stroke="#426EAE" strokeWidth="3" /><path d="M112 134c10-26 24-36 41-32M166 137c13-35 33-43 48-26M215 140c10-24 26-26 37-17" stroke="#805975" strokeWidth="10" strokeLinecap="round" /><path d="M147 74c-22-19 18-29 1-49M186 68c-20-19 18-29 1-49" stroke="#B5C7DF" strokeWidth="4" strokeLinecap="round" /><path d="m237 118 49-89m-32 91 47-87" stroke="#805975" strokeWidth="5" strokeLinecap="round" /><path d="M130 229h100" stroke="#426EAE" strokeWidth="5" strokeLinecap="round" /><path d="M93 183c15 20 31 26 54 30" stroke="#fff" strokeWidth="5" strokeLinecap="round" /></svg></div><h1>认真吃饭，<br />慢慢了解自己。</h1><p>餐食、份量、身体的日常。<br />把零散的小记录，留在自己的账本里。</p></section><section className="login-form-wrap"><div className="login-form-inner"><span className="login-lock"><Icon name="lock" size={24} /></span><h2>欢迎回到 Boji</h2><p className="muted">输入访问密码，打开你的健康日记。</p>{message && <p className="info-note">{message}</p>}<form onSubmit={login}>{error && <ErrorNotice message={error} />}<div className="field"><label htmlFor="password">访问密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={pending} autoFocus placeholder="输入你的密码" /></div><button type="submit" className="button primary login-submit" disabled={pending || !password}>{pending ? '正在打开…' : '打开我的日记'}</button></form><p className="login-footnote"><Icon name="leaf" size={15} />属于你的记录，由你来修正。</p></div></section></main>;
}
