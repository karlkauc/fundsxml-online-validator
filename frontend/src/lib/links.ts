/** External links shared by the header and the About dialog. */
export const GITHUB_REPO_URL = "https://github.com/karlkauc/xml-online-viewer";
export const XSD_VIEWER_URL = "https://www.xsd-viewer.online/";
export const FUNDSXML_URL = "https://fundsxml.org";
/**
 * FreeXmlToolkit — the author's free desktop XML workstation (Java, Apache
 * 2.0; Windows, macOS, Linux). Links go through the same-origin `/go/…`
 * redirect so clicks show up in the usage statistics.
 */
export const FREEXMLTOOLKIT_URL = "https://karlkauc.github.io/FreeXmlToolkit/";
export const FREEXMLTOOLKIT_RELEASES_URL = "https://github.com/karlkauc/FreeXmlToolkit/releases";
export const FREEXMLTOOLKIT_GO = "/go/freexmltoolkit";
export const FREEXMLTOOLKIT_DOWNLOAD_GO = "/go/freexmltoolkit?to=releases";
/** Example instance document offered in the "XML data" panel. It carries an
 * xsi:noNamespaceSchemaLocation, so loading it also exercises auto-detection
 * of the schema and validation in one click. */
export const FUNDSXML_SAMPLE_URL =
  "https://raw.githubusercontent.com/fundsxml/examples/main/FundsXML_Files/4.2.9/positions/Mixed-Fund_Positions.xml";

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
