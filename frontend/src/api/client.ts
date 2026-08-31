import type {
  ValidationResponse,
  XmlDocModel,
  XsdInfo,
} from "../types/model";

const API_BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // ignore parse errors; fall back to status
    }
    throw new ApiError(detail, response.status);
  }
  return (await response.json()) as T;
}

// --- XML data -------------------------------------------------------------

export async function uploadXmlFile(file: File): Promise<XmlDocModel> {
  const form = new FormData();
  form.append("file", file);
  return handle<XmlDocModel>(
    await fetch(`${API_BASE}/xml/upload`, { method: "POST", body: form }),
  );
}

export async function uploadXmlText(
  content: string,
  filename = "document.xml",
): Promise<XmlDocModel> {
  return handle<XmlDocModel>(
    await fetch(`${API_BASE}/xml/text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, filename }),
    }),
  );
}

export async function uploadXmlUrl(url: string): Promise<XmlDocModel> {
  return handle<XmlDocModel>(
    await fetch(`${API_BASE}/xml/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  );
}

// --- XSD schema -----------------------------------------------------------

export async function uploadXsdFile(
  file: File,
  mainFilename?: string,
): Promise<XsdInfo> {
  const form = new FormData();
  form.append("file", file);
  if (mainFilename) form.append("main_filename", mainFilename);
  return handle<XsdInfo>(
    await fetch(`${API_BASE}/xsd/upload`, { method: "POST", body: form }),
  );
}

export async function uploadXsdText(
  content: string,
  filename = "schema.xsd",
): Promise<XsdInfo> {
  return handle<XsdInfo>(
    await fetch(`${API_BASE}/xsd/text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, filename }),
    }),
  );
}

export async function uploadXsdUrl(url: string): Promise<XsdInfo> {
  return handle<XsdInfo>(
    await fetch(`${API_BASE}/xsd/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  );
}

/** Load the schema the XML document itself points at (xsi:schemaLocation /
 * xsi:noNamespaceSchemaLocation), including everything it imports. 404 when
 * the document names no downloadable schema. */
export async function autoLoadXsd(xmlId: string): Promise<XsdInfo> {
  return handle<XsdInfo>(
    await fetch(`${API_BASE}/xsd/auto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xml_id: xmlId }),
    }),
  );
}

// --- Validation -----------------------------------------------------------

export async function runValidation(
  xmlId: string,
  xsdId: string,
): Promise<ValidationResponse> {
  return handle<ValidationResponse>(
    await fetch(`${API_BASE}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xml_id: xmlId, xsd_id: xsdId }),
    }),
  );
}

export function excelReportUrl(validationId: string): string {
  return `${API_BASE}/validate/${validationId}/excel`;
}

// --- FundsXML releases (GitHub) ------------------------------------------

export interface FundsXmlAsset {
  filename: string;
  download_url: string;
  size: number;
  content_type: string | null;
}

export interface FundsXmlRelease {
  tag_name: string;
  name: string | null;
  published_at: string;
  prerelease: boolean;
  html_url: string;
  assets: FundsXmlAsset[];
}

export interface FundsXmlReleasesResponse {
  releases: FundsXmlRelease[];
  cached_at: string;
  ttl_seconds: number;
}

export async function listFundsXmlReleases(): Promise<FundsXmlReleasesResponse> {
  return handle<FundsXmlReleasesResponse>(
    await fetch(`${API_BASE}/fundsxml/releases`),
  );
}

export async function loadXsdFromRelease(
  tagName: string,
  mainFilename: string,
): Promise<XsdInfo> {
  return handle<XsdInfo>(
    await fetch(
      `${API_BASE}/fundsxml/releases/${encodeURIComponent(tagName)}/load`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ main_filename: mainFilename }),
      },
    ),
  );
}

// --- Feedback & health ----------------------------------------------------

export interface FeedbackPayload {
  message: string;
  email?: string;
  page?: string;
  xml_name?: string;
  xsd_name?: string;
  error_detail?: string;
  /** Honeypot; always empty for real users. */
  website?: string;
}

export async function sendFeedback(payload: FeedbackPayload): Promise<void> {
  const response = await fetch(`${API_BASE}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // ignore
    }
    throw new ApiError(detail, response.status);
  }
}

export interface HealthResponse {
  status: string;
  version: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return handle<HealthResponse>(await fetch(`${API_BASE}/health`));
}
