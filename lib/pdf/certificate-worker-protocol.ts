import type {
  CertificateExportMetadata,
  CertificateRenderMetadata,
} from './certificate-client-contract.ts';

export type CertificateWorkerRequest =
  | Readonly<{
      type: 'render-certificate';
      taskId: string;
      metadata: CertificateRenderMetadata;
    }>
  | Readonly<{
      type: 'render-archive';
      taskId: string;
      metadata: CertificateExportMetadata;
      stream: boolean;
      /**
       * Ports to helper workers that render certificates in parallel with
       * this one; transferred with the first archive request of a session
       * and kept for the following parts.
       */
      renderPorts?: readonly MessagePort[];
    }>
  | Readonly<{
      /** Turns this worker into a helper that answers `render-certificate` on the port. */
      type: 'serve';
      taskId: string;
      port: MessagePort;
    }>
  | Readonly<{
      type: 'cancel';
      taskId: string;
    }>
  | Readonly<{
      type: 'chunk-ack';
      taskId: string;
      sequence: number;
    }>;

export type CertificateWorkerResponse =
  | Readonly<{
      type: 'progress';
      taskId: string;
      completed: number;
      total: number;
    }>
  | Readonly<{
      type: 'chunk';
      taskId: string;
      sequence: number;
      bytes: ArrayBuffer;
    }>
  | Readonly<{
      type: 'result';
      taskId: string;
      bytes: ArrayBuffer;
      filename: string;
    }>
  | Readonly<{
      type: 'complete';
      taskId: string;
      filename: string;
    }>
  | Readonly<{
      type: 'error';
      taskId: string;
      code: string;
    }>;
