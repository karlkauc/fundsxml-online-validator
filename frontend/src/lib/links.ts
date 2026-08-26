/** External links shared by the header and the About dialog. */
export const GITHUB_REPO_URL = "https://github.com/karlkauc/xml-online-viewer";
export const XSD_VIEWER_URL = "https://www.xsd-viewer.online/";
export const FUNDSXML_URL = "https://fundsxml.org";

/** Window events used to open the global dialogs / focus search from anywhere. */
export const EVENT_OPEN_FEEDBACK = "xmlv:open-feedback";
export const EVENT_OPEN_ABOUT = "xmlv:open-about";
export const EVENT_OPEN_SEARCH = "xmlv:open-search";

export interface FeedbackContext {
  errorDetail?: string;
}

export function openFeedback(detail: FeedbackContext = {}): void {
  window.dispatchEvent(new CustomEvent(EVENT_OPEN_FEEDBACK, { detail }));
}

export function openAbout(): void {
  window.dispatchEvent(new CustomEvent(EVENT_OPEN_ABOUT));
}

export function openSearch(): void {
  window.dispatchEvent(new CustomEvent(EVENT_OPEN_SEARCH));
}
