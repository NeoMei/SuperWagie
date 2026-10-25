/** UI state only. This key must never be used as a filesystem directory. */
export const PRODUCT_HELP_PANEL_KEY = '__product_help__';

/** Callers normalize real directories before selecting the panel state key. */
export const productHelpPanelKey = (directoryKey: string): string => directoryKey || PRODUCT_HELP_PANEL_KEY;
