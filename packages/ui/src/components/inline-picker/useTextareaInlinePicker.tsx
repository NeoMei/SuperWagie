/** A paste or a drop brings text the user did not type. */
export const isPastedInput = (event: Event): boolean => (
  event instanceof InputEvent && /^insertFrom(Paste|Drop)/.test(event.inputType)
);
