export const createCopyLinkMenuHook = ({ clipboard, ClipboardItem, onError }) => (defaultActions, properties) => {
  // electron-context-menu 4.1.2 returns the item already in its template.
  // Replace only its handler so ordering, visibility and live labels stay intact.
  defaultActions.copyLink().click = async () => {
    try {
      if (ClipboardItem) {
        await clipboard.write([
          new ClipboardItem({
            'text/plain': properties.linkURL,
            'electron application/bookmark': {
              title: properties.linkText,
              url: properties.linkURL,
            },
          }),
        ]);
      } else {
        // Electron 43 keeps the object-shaped clipboard API on macOS 12.
        await clipboard.write({ text: properties.linkURL, bookmark: properties.linkText });
      }
    } catch {
      // Clipboard payloads and native error messages can contain private URLs.
      onError();
    }
  };
  return [];
};
