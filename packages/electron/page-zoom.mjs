/** Interface scaling belongs to the app; native page zoom stays at its default. */
export const disableNativePageZoom = (contents, onError) => {
  if (contents.setZoomMode) {
    contents.setZoomMode('disabled');
    return;
  }
  // Electron 43 supports Monterey but predates the per-WebContents zoom API.
  void contents.setVisualZoomLevelLimits(1, 1).catch(onError);
  contents.on('zoom-changed', () => contents.setZoomLevel(0));
};
