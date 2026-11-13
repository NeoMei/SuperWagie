import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';
import { navigateFromNotification } from '@openchamber/ui/lib/router/notificationNavigation';
import { withdrawDesktopEventNotification } from '@openchamber/ui/lib/desktop';
import { z } from 'zod';

const SW_READY_TIMEOUT_MS = 1500;
const NOTIFICATION_DEDUPE_TTL_MS = 5000;
const NOTIFICATION_DEDUPE_STORAGE_PREFIX = 'openchamber-notification-claim:';

const notificationClaims = new Map<string, number>();
const liveNotifications = new Map<string, Set<Notification>>();
const notificationOwnerKey = (tag: string, runtimeKey?: string) => JSON.stringify([runtimeKey || 'local', tag]);

const isClientFocused = (): boolean => {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
};

const buildSessionTargetUrl = (sessionId?: string): string | null => {
  if (typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  return `/?session=${encodeURIComponent(trimmed)}`;
};

type NotificationTarget = {
  url: string;
  sessionId: string;
  runtimeKey?: string;
};

const getNotificationTarget = (payload?: NotificationPayload): NotificationTarget | undefined => {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId) return undefined;
  const url = buildSessionTargetUrl(sessionId);
  if (!url) return undefined;
  const target: NotificationTarget = { url, sessionId };
  if (payload?.runtimeKey) target.runtimeKey = payload.runtimeKey;
  return target;
};

type NotificationOptionsWithTarget = NotificationOptions & {
  data?: { url?: string; sessionId?: string; runtimeKey?: string };
};

const withNotificationTarget = (
  payload: NotificationPayload | undefined,
  target: NotificationTarget | undefined,
): NotificationOptionsWithTarget => {
  const options: NotificationOptionsWithTarget = {
    body: payload?.body,
    tag: payload?.tag,
  };
  if (target) {
    options.data = target;
  } else if (payload?.runtimeKey) options.data = { runtimeKey: payload.runtimeKey };
  return options;
};

const focusOrOpenNotificationTarget = (target?: NotificationTarget): void => {
  try {
    if (typeof window === 'undefined') return;
    if (typeof window.focus === 'function') {
      window.focus();
    }
    if (!target) return;
    const current = `${window.location.pathname}${window.location.search}`;
    if (current === target.url) return;
    if (navigateFromNotification(target.url)) return;
    window.location.assign(target.url);
  } catch {
    // Navigation is best-effort; the notification was already shown.
  }
};

const getNotificationClaimKey = (payload?: NotificationPayload): string => {
  const tag = typeof payload?.tag === 'string' ? payload.tag.trim() : '';
  if (tag) return JSON.stringify([payload?.runtimeKey || 'local', tag]);

  return [payload?.sessionId, payload?.kind, payload?.title, payload?.body]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('|');
};

const pruneNotificationClaims = (now: number): void => {
  for (const [key, claimedAt] of notificationClaims) {
    if (now - claimedAt > NOTIFICATION_DEDUPE_TTL_MS) {
      notificationClaims.delete(key);
    }
  }
};

const claimNotificationPayload = (payload?: NotificationPayload): boolean => {
  const key = getNotificationClaimKey(payload);
  if (!key) return true;

  const now = Date.now();
  pruneNotificationClaims(now);

  const claimedAt = notificationClaims.get(key) ?? 0;
  if (now - claimedAt < NOTIFICATION_DEDUPE_TTL_MS) {
    return false;
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const storageKey = `${NOTIFICATION_DEDUPE_STORAGE_PREFIX}${key}`;
      const stored = Number(window.localStorage.getItem(storageKey) ?? '0');
      if (Number.isFinite(stored) && now - stored < NOTIFICATION_DEDUPE_TTL_MS) {
        notificationClaims.set(key, stored);
        return false;
      }
      if (Number.isFinite(stored) && stored > 0) {
        window.localStorage.removeItem(storageKey);
      }
      window.localStorage.setItem(storageKey, String(now));
    }
  } catch {
    // Storage is best-effort; in-memory dedupe still covers duplicate streams in this tab.
  }

  notificationClaims.set(key, now);
  return true;
};

const getNotificationRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  let existing: ServiceWorkerRegistration | null = null;
  try {
    existing = (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    existing = null;
  }

  if (existing?.active) {
    return existing;
  }

  if (!existing) {
    return null;
  }

  try {
    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS);
      }),
    ]);

    return ready ?? existing;
  } catch {
    return existing;
  }
};

const notifyWithServiceWorker = async (payload?: NotificationPayload): Promise<boolean> => {
  const registration = await getNotificationRegistration();
  if (!registration || typeof registration.showNotification !== 'function') {
    return false;
  }

  try {
    const target = getNotificationTarget(payload);
    await registration.showNotification(
      payload?.title ?? '犇马',
      withNotificationTarget(payload, target),
    );
    return true;
  } catch (error) {
    console.warn('Failed to send notification via service worker', error);
    return false;
  }
};

const hasActivePushSubscription = async (): Promise<boolean> => {
  const registration = await getNotificationRegistration();
  if (!registration || !('pushManager' in registration) || !registration.pushManager) {
    return false;
  }

  try {
    return Boolean(await registration.pushManager.getSubscription());
  } catch {
    return false;
  }
};

const notifyWithWebAPI = async (payload?: NotificationPayload): Promise<boolean> => {
  if (payload?.requireHidden && typeof document !== 'undefined' && document.hasFocus()) {
    return true;
  }

  if (typeof Notification === 'undefined') {
    console.info('Notifications not supported in this environment', payload);
    return false;
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted');
      return false;
    }
  }

  if (Notification.permission !== 'granted') {
    console.warn('Notification permission not granted');
    return false;
  }

  // Background push is the delivery channel when the web/PWA client is not
  // focused. Keep the main notification toggle and templates enabled, but avoid
  // also showing the same foreground notification from a hidden page.
  if (!isClientFocused() && await hasActivePushSubscription()) {
    return true;
  }

  if (!claimNotificationPayload(payload)) {
    return true;
  }

  try {
    // Some installed PWAs expose Notification.permission but only allow
    // notifications through an active service worker registration.
    if (await notifyWithServiceWorker(payload)) {
      return true;
    }

    const target = getNotificationTarget(payload);
    const notification = new Notification(
      payload?.title ?? '犇马',
      withNotificationTarget(payload, target),
    );
    if (payload?.tag) {
      const owner = notificationOwnerKey(payload.tag, payload.runtimeKey);
      const active = liveNotifications.get(owner) ?? new Set<Notification>();
      active.add(notification);
      liveNotifications.set(owner, active);
      notification.onclose = () => { active.delete(notification); if (!active.size) liveNotifications.delete(owner); };
    }
    notification.onclick = (event) => {
      event.preventDefault();
      focusOrOpenNotificationTarget(target);
      notification.close();
    };
    return true;
  } catch (error) {
    console.warn('Failed to send notification', error);
    return false;
  }
};

const notifyWithDesktop = async (payload?: NotificationPayload): Promise<boolean> => {
  if (typeof window === 'undefined') {
    return false;
  }

  const desktop = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
  if (!desktop?.invoke) {
    return false;
  }

  try {
    await desktop.invoke('desktop_notify', {
      payload: {
        title: payload?.title,
        body: payload?.body,
        tag: payload?.tag,
        kind: payload?.kind,
        sessionId: payload?.sessionId,
        directory: payload?.directory,
        runtimeKey: payload?.runtimeKey,
        requireHidden: payload?.requireHidden,
        showWhenFocused: payload?.showWhenFocused,
      },
    });
    return true;
  } catch (error) {
    console.warn('Failed to send native notification (desktop)', error);
    return false;
  }
};

export const createWebNotificationsAPI = (): NotificationsAPI => ({
  async withdraw(input) {
    const parsed = z.object({ tag: z.string().min(1).max(200), runtimeKey: z.string().optional() }).parse(input);
    const desktop = await withdrawDesktopEventNotification(parsed);
    if (desktop) return desktop;
    let count = 0;
    let supported = false;
    const owner = notificationOwnerKey(parsed.tag, parsed.runtimeKey);
    const active = liveNotifications.get(owner);
    if (active) {
      supported = true;
      for (const notification of active) { notification.close(); count++; }
      liveNotifications.delete(owner);
    }
    const registration = await getNotificationRegistration();
    const getNotifications = z.function().safeParse(registration?.getNotifications);
    if (getNotifications.success && registration) {
      supported = true;
      try {
        for (const notification of await registration.getNotifications({ tag: parsed.tag })) {
          if (notification.tag !== parsed.tag || notification.data?.runtimeKey !== parsed.runtimeKey) continue;
          notification.close(); count++;
        }
      } catch { return { status: 'unknown' }; }
    }
    return count ? { status: 'withdrawn', count } : { status: supported ? 'unknown' : 'unsupported' };
  },
  async notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean> {
    return (await notifyWithDesktop(payload)) || (await notifyWithWebAPI(payload));
  },
  canNotify: () => {
    if (typeof window !== 'undefined') {
      const desktop = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
      if (desktop?.invoke) {
        return true;
      }
    }
    return typeof Notification !== 'undefined' ? Notification.permission === 'granted' : false;
  },
});
type DesktopBridgeGlobal = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};
