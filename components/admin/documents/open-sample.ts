import type { PreviewJob } from '@/lib/pdf/document-preview-job';

type RenderJob = Extract<PreviewJob, { kind: 'certificate' | 'protocol' }>;

/**
 * Draws the sample a job describes and opens it in a tab of its own. The tab is
 * opened at the click, before the document is drawn: a browser lets a page open
 * a window only while the click is still being handled.
 */
export async function openSamplePdf(job: RenderJob, filename: string) {
  const tab = window.open('', '_blank');
  try {
    let bytes: Uint8Array;
    if (job.kind === 'certificate') {
      const { generateCertificatePreview } = await import('@/lib/pdf/certificate-renderer');
      bytes = await generateCertificatePreview(job.input);
    } else {
      const { generateProtocolInBrowser } = await import('@/lib/pdf/protocol-renderer');
      bytes = await generateProtocolInBrowser(job.input, job.branding, job.fontUrl);
    }
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
    );
    if (tab) tab.location.href = url;
    else {
      // A blocked window still gets the file: it is saved instead of shown.
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}
