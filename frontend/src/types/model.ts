// Mirrors the Pydantic models in backend/app/parser/{xml_tree,validate}.py
// and the XsdInfo response in backend/app/api/xsd.py. Kept in sync manually.

export interface XmlAttribute {
  name: string;
  value: string;
}

export interface XmlNode {
  id: string;
  kind: "element" | "comment" | "pi";
  tag: string;
  local_name: string | null;
  namespace: string | null;
  prefix: string | null;
  attributes: XmlAttribute[];
  text: string | null;
  line: number | null;
  children: XmlNode[];
}

/** A schema the document points at via xsi:schemaLocation /
 * xsi:noNamespaceSchemaLocation. `resolved_url` is set only when it is
 * fetchable; a relative location in an uploaded file refers to the user's own
 * disk and must be loaded manually. */
export interface SchemaHint {
  namespace: string | null;
  location: string;
  resolved_url: string | null;
}

export interface XmlDocModel {
  xml_id: string;
  filename: string;
  root: XmlNode;
  reformatted_xml: string;
  namespaces: Record<string, string>;
  node_count: number;
  source_url: string | null;
  schema_hints: SchemaHint[];
}

export interface XsdInfo {
  xsd_id: string;
  main_filename: string;
  filenames: string[];
}

export type Severity = "fatal" | "error" | "warning";

export interface ValidationErrorItem {
  line: number | null;
  column: number | null;
  message: string;
  severity: Severity;
  type_name: string | null;
  domain: string | null;
  path: string | null;
  node_id: string | null;
}

export interface ValidationResponse {
  validation_id: string;
  xml_id: string;
  xsd_id: string;
  is_valid: boolean;
  errors: ValidationErrorItem[];
}
