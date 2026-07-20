import { SerializedBundle } from "@sigstore/bundle";

export interface ProcessReport {
  header?: ProcessReportHeader;
}

interface ProcessReportHeader {
  glibcVersionRuntime?: string;
}

export interface AttestationResponse {
  attestations: Attestation[];
}

export interface Attestation {
  repository_id: number;
  bundle: SerializedBundle;
}
export interface AttestationStatement {
  subject: {
    digest?: { sha256: string };
  }[];
}
