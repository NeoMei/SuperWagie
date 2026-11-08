import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { PlatformAccountError } from '@/lib/platformAccount';
import { readPlatformUsageActivity, type PlatformUsageActivity } from '@/lib/platformUsageActivity';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { ClockPausedContext } from '@/hooks/clockPausedContext';

type Report = { status: 'loading' | 'denied' | 'failed' } | {
  status: 'ready'; data: PlatformUsageActivity; accountId: string;
  runtimeCurrent: () => boolean; refresh: 'idle' | 'loading' | 'failed';
};
const LEVELS = ['bg-chart-1/20', 'bg-chart-1/40', 'bg-chart-1/65', 'bg-chart-1'] as const;

export const PlatformAccountUsageChart = ({ accountId }: { accountId: string }) => {
  const { t } = useI18n();
  const [report, setReport] = React.useState<Report>({ status: 'loading' });
  const [focusedDay, setFocusedDay] = React.useState(364);
  const dayRefs = React.useRef(new Map<number, HTMLButtonElement>());
  const chartRef = React.useRef<HTMLDivElement>(null);
  const requestVersion = React.useRef(0);
  const requestPending = React.useRef(false);
  const paused = React.useContext(ClockPausedContext);
  const load = React.useCallback(async () => {
    if (requestPending.current) return;
    requestPending.current = true;
    const current = ++requestVersion.current;
    const runtimeCurrent = captureRuntimeInstance();
    setReport((previous) => previous.status === 'ready' && previous.accountId === accountId && previous.runtimeCurrent()
      ? { ...previous, refresh: 'loading' } : { status: 'loading' });
    try {
      const data = await readPlatformUsageActivity(accountId);
      if (current === requestVersion.current && runtimeCurrent()) setReport({ status: 'ready', data, accountId, runtimeCurrent, refresh: 'idle' });
    } catch (error) {
      if (current !== requestVersion.current || !runtimeCurrent()) return;
      const invalidated = error instanceof PlatformAccountError && ([401, 403].includes(error.status)
        || ['platform_session_changed', 'platform_account_changed', 'platform_session_expired', 'unauthenticated', 'platform_account_forbidden', 'platform_billing_forbidden', 'platform_scope_required', 'forbidden'].includes(error.code));
      setReport((previous) => !invalidated && previous.status === 'ready' && previous.accountId === accountId && previous.runtimeCurrent()
        ? { ...previous, refresh: 'failed' }
        : { status: error instanceof PlatformAccountError && error.status === 403 ? 'denied' : 'failed' });
    } finally {
      if (current === requestVersion.current) requestPending.current = false;
    }
  }, [accountId]);
  React.useEffect(() => {
    void load();
    return () => { requestVersion.current += 1; requestPending.current = false; };
  }, [load]);

  const data = report.status === 'ready' && report.accountId === accountId && report.runtimeCurrent() ? report.data : null;
  const refresh = report.status === 'ready' ? report.refresh : 'idle';
  const polling = !paused && refresh === 'idle' && data?.sync?.status === 'syncing';
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!polling || !chart || report.status !== 'ready') return;
    const doc = chart.ownerDocument;
    const view = doc.defaultView;
    if (!view) return;
    const Observer = view.IntersectionObserver;
    const runtimeCurrent = report.runtimeCurrent;
    let visible = !Observer;
    let timer: number | undefined;
    const cancel = () => { if (timer !== undefined) { view.clearTimeout(timer); timer = undefined; } };
    const schedule = () => {
      cancel();
      if (!visible || doc.visibilityState === 'hidden' || !runtimeCurrent()) return;
      timer = view.setTimeout(() => {
        timer = undefined;
        if (visible && doc.visibilityState !== 'hidden' && runtimeCurrent()) void load();
      }, 10_000);
    };
    const observer = Observer ? new Observer((entries) => {
      visible = entries.some((entry) => entry.target === chart && entry.isIntersecting);
      schedule();
    }) : null;
    observer?.observe(chart);
    doc.addEventListener('visibilitychange', schedule);
    schedule();
    return () => { cancel(); observer?.disconnect(); doc.removeEventListener('visibilitychange', schedule); };
  }, [data, load, polling, report]);
  const maximum = data?.days.reduce((max, day) => BigInt(day.calls) > max ? BigInt(day.calls) : max, 0n) ?? 0n;
  const dateFormat = new Intl.DateTimeFormat(getCurrentIntlLocale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const monthFormat = new Intl.DateTimeFormat(getCurrentIntlLocale(), { month: 'short', timeZone: 'UTC' });
  const dateFor = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));
  const first = data?.days[0];
  const padding = first ? new Date(`${first.date}T00:00:00Z`).getUTCDay() : 0;
  const columns = data ? Math.ceil((padding + data.days.length) / 7) : 53;
  const cells = data ? Array.from({ length: columns * 7 }, (_, index) => data.days[index - padding] ?? null) : [];
  const months = new Map(data?.days.flatMap((day, index) => index === 0 || day.date.endsWith('-01') ? [[Math.floor((padding + index) / 7), day.date] as const] : []));
  const levelFor = (calls: string) => maximum === 0n ? 0 : Math.min(3, Number((BigInt(calls) * 3n) / maximum));
  const dayLabel = (day: PlatformUsageActivity['days'][number]) => t(day.coverage === 'complete' ? 'platformAccount.activity.day'
    : day.coverage === 'unknown' || day.calls === '0' ? 'platformAccount.activity.dayUnknown' : 'platformAccount.activity.dayPartial', { date: dateFor(day.date), count: day.calls });
  const activeDays = data?.days.filter((day) => day.calls !== '0').length ?? 0;
  const savedTime = data?.savedAt ? new Intl.DateTimeFormat(getCurrentIntlLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(data.savedAt)) : null;
  const syncFailed = refresh === 'failed' || data?.sync?.status === 'failed';
  const status = !data ? '' : refresh === 'loading'
    ? savedTime ? t('platformAccount.activity.refreshingSaved', { time: savedTime }) : t('platformAccount.activity.refreshing')
    : refresh === 'failed' ? savedTime ? t('platformAccount.activity.refreshFailedSaved', { time: savedTime }) : t('platformAccount.activity.refreshFailed')
      : data.sync?.status === 'failed' ? savedTime ? t('platformAccount.activity.syncFailedSaved', { time: savedTime }) : t('platformAccount.activity.syncFailed')
      : data.sync?.status === 'syncing' ? savedTime ? t('platformAccount.activity.syncingSaved', { time: savedTime }) : t('platformAccount.activity.syncing')
        : savedTime ? t('platformAccount.activity.savedAt', { time: savedTime }) : '';
  const focusDate = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = (padding + index) % 7;
    const offset = event.key === 'ArrowLeft' ? -7 : event.key === 'ArrowRight' ? 7
      : event.key === 'ArrowUp' && row > 0 ? -1 : event.key === 'ArrowDown' && row < 6 ? 1 : null;
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? 364 : offset === null ? null : index + offset;
    if (target === null) return;
    event.preventDefault();
    if (target < 0 || target >= (data?.days.length ?? 0)) return;
    dayRefs.current.get(target)?.focus();
  };

  return <SettingsSection title={t('platformAccount.activity.title')} divider={false} className="pb-4" contentClassName="space-y-3" headerAction={
    <Button size="sm" variant="ghost" disabled={report.status === 'loading' || refresh === 'loading'} onClick={() => void load()}>{t('platformAccount.activity.refresh')}</Button>
  }>
    <div ref={chartRef} className="oc-tile min-h-44 rounded-lg px-4 py-4">
      {!data ? <p className={SETTINGS_HELPER_CLASS} role="status">{t(report.status === 'loading' || report.status === 'ready' ? 'platformAccount.loading' : report.status === 'denied' ? 'platformAccount.usageDenied' : 'platformAccount.usageFailed')}</p> : <>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="font-medium tabular-nums">{t(data.complete ? 'platformAccount.activity.total' : 'platformAccount.activity.totalPartial', { count: data.total })}</p>
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.activity.period')}</p>
        </div>
        <div className="mt-4 min-w-0 overflow-x-auto pb-1" dir="ltr">
          <div className="w-max">
            <div className="relative mb-2 ms-10 h-4 typography-micro text-muted-foreground" style={{ width: columns * 14 - 3 }} aria-hidden="true">
              {Array.from(months, ([column, date]) => <span key={date} className="absolute whitespace-nowrap" style={{ insetInlineStart: column * 14 }}>{monthFormat.format(new Date(`${date}T00:00:00Z`))}</span>)}
            </div>
            <div className="flex gap-3">
              <div className="grid w-7 shrink-0 typography-micro text-muted-foreground" style={{ gridTemplateRows: 'repeat(7, 11px)', gap: 3 }} aria-hidden="true">
                {Array.from({ length: 7 }, (_, row) => <span key={row} className="leading-[11px]">{row === 1 ? t('platformAccount.activity.weekdayMonday') : row === 3 ? t('platformAccount.activity.weekdayWednesday') : row === 5 ? t('platformAccount.activity.weekdayFriday') : null}</span>)}
              </div>
              <div className="grid grid-flow-col" style={{ gridTemplateColumns: `repeat(${columns}, 11px)`, gridTemplateRows: 'repeat(7, 11px)', gap: 3 }} role="group" aria-label={t('platformAccount.activity.period')}>
                {cells.map((day, cellIndex) => day ? <Tooltip key={day.date}>
                  <TooltipTrigger asChild>
                    <button ref={(node) => { if (node) dayRefs.current.set(cellIndex - padding, node); else dayRefs.current.delete(cellIndex - padding); }} type="button" tabIndex={focusedDay === cellIndex - padding ? 0 : -1} onFocus={() => setFocusedDay(cellIndex - padding)} onKeyDown={(event) => focusDate(event, cellIndex - padding)} className={`size-[11px] rounded-[2px] ${day.calls === '0' ? day.coverage === 'complete' ? 'oc-tile-inset' : 'bg-transparent outline-solid outline-1 -outline-offset-1 outline-border/60' : LEVELS[levelFor(day.calls)]} focus-visible:opacity-60`} aria-label={dayLabel(day)}>
                      <span className="sr-only">{day.date}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{dayLabel(day)}</TooltipContent>
                </Tooltip> : <span key={`padding-${cellIndex}`} aria-hidden="true" />)}
              </div>
            </div>
            {first && <div className="mt-2 ms-10 flex justify-between gap-2 typography-micro text-muted-foreground"><span>{dateFor(first.date)}</span><span>{dateFor(data.days[data.days.length - 1].date)}</span></div>}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className={SETTINGS_HELPER_CLASS}>{t(data.complete ? 'platformAccount.activity.activeDays' : activeDays === 1 ? 'platformAccount.activity.activeDayPartial' : 'platformAccount.activity.activeDaysPartial', { count: activeDays })}</p>
          <div className="flex items-center gap-1 typography-micro text-muted-foreground" aria-hidden="true"><span className="me-1">{t('platformAccount.activity.less')}</span><span className="oc-tile-inset size-[11px] rounded-[2px]" />{LEVELS.map((level) => <span key={level} className={`size-[11px] rounded-[2px] ${level}`} />)}<span className="ms-1">{t('platformAccount.activity.more')}</span></div>
        </div>
      </>}
    </div>
    <p className={`min-h-5 truncate ${syncFailed ? 'typography-meta text-[var(--status-warning-text)]' : SETTINGS_HELPER_CLASS}`} role="status" title={status}>{status}</p>
    {data?.visibility === 'actor' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageActorScope')}</p>}
    {data && !data.complete && <p className={SETTINGS_HELPER_CLASS} role="status">{t('platformAccount.activity.partial')}</p>}
    {data && data.unknownTime !== '0' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.activity.unknownTime', { count: data.unknownTime })}</p>}
  </SettingsSection>;
};
