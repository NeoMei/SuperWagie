import { create } from 'zustand';

/**
 * A project file a guest page asked the host to show above it. The host reads
 * the file itself; the guest only names a project-relative path. The overlay
 * is transient: closing it returns to the same page and stage.
 */
type GuestPreview = {
  path: string;
  directory: string | null;
};

type GuestPreviewStore = {
  preview: GuestPreview | null;
  open: (preview: GuestPreview) => void;
  close: () => void;
};

export const useGuestPreviewStore = create<GuestPreviewStore>((set) => ({
  preview: null,
  open: (preview) => set({ preview }),
  close: () => set({ preview: null }),
}));
