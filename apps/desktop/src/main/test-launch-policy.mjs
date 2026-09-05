// Never let development test flags suppress a packaged application's UI.
export function isBackgroundUiTest(isPackaged, environment) {
  return !isPackaged && environment.SUPERWAGIE_TEST_MODE === '1'
    && environment.SUPERWAGIE_TEST_BACKGROUND === '1';
}
