/**
 * Minimal Google Drive client used by `gdrive-direct` file-import bindings.
 *
 * Auth model: API key only (no OAuth). The user shares a specific folder
 * with "Anyone with the link" in Drive, pastes the folder URL into Folio,
 * and supplies a personal API key from Google Cloud Console. Drive's API
 * accepts the request because the folder is publicly readable; the key
 * just identifies the calling project for quota purposes.
 *
 * No SDK dependency — Drive REST v3 is straightforward, three endpoints
 * cover everything the wizard and the scheduler need.
 */

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** ISO 8601 */
  createdTime?: string;
  /** ISO 8601 */
  modifiedTime?: string;
  size?: number;
  webViewLink?: string;
}

export class GDriveClient {
  constructor(private apiKey: string) {}

  /** Extract folder ID from any of the URL shapes Drive uses:
   *    https://drive.google.com/drive/folders/{ID}
   *    https://drive.google.com/drive/u/0/folders/{ID}?usp=sharing
   *    bare ID
   *  Returns null if no folder ID found. */
  static parseFolderUrl(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // Try matching the canonical /folders/<id> pattern
    const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
    if (match) return match[1];

    // Already a bare ID? Drive IDs are 25-44 chars of [a-zA-Z0-9_-]
    if (/^[a-zA-Z0-9_-]{25,44}$/.test(trimmed)) return trimmed;

    return null;
  }

  /** Fetch metadata for a folder. Used to validate access at wizard time —
   *  if this fails the user knows their share/key setup is wrong. */
  async getFolderMetadata(folderId: string): Promise<DriveFile> {
    const url = new URL(`${DRIVE_BASE}/files/${folderId}`);
    url.searchParams.set('fields', 'id,name,mimeType,createdTime,modifiedTime,webViewLink');
    url.searchParams.set('key', this.apiKey);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive ${res.status}: ${body || res.statusText}`);
    }
    return (await res.json()) as DriveFile;
  }

  /** List files directly inside a folder. Excludes sub-folders; we don't
   *  recurse for now (folder bindings are flat by design — one folder maps
   *  to one Finmap account). */
  async listFiles(folderId: string, opts?: { pageSize?: number; orderBy?: string }): Promise<DriveFile[]> {
    const pageSize = opts?.pageSize ?? 100;
    const orderBy = opts?.orderBy ?? 'modifiedTime desc';
    const all: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${DRIVE_BASE}/files`);
      url.searchParams.set('q', `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`);
      url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,webViewLink)');
      url.searchParams.set('orderBy', orderBy);
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('key', this.apiKey);
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Drive ${res.status}: ${body || res.statusText}`);
      }
      const data = await res.json() as { files?: DriveFile[]; nextPageToken?: string };
      if (Array.isArray(data.files)) {
        // Coerce size to number — Drive returns it as string
        for (const f of data.files) {
          if (typeof f.size === 'string') f.size = Number(f.size);
        }
        all.push(...data.files);
      }
      pageToken = data.nextPageToken;
    } while (pageToken && all.length < 1000); // safety cap

    return all;
  }

  /** Download raw file content. For binary formats (xlsx, pdf, images) returns
   *  base64-encoded — Claude expects text-or-image, never raw bytes, so the
   *  caller decides how to ingest. For Google-native types (Docs/Sheets) the
   *  caller must use `exportFile` instead. */
  async downloadFile(fileId: string): Promise<{ base64: string; size: number }> {
    const url = new URL(`${DRIVE_BASE}/files/${fileId}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('key', this.apiKey);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive ${res.status}: ${body || res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { base64: buf.toString('base64'), size: buf.length };
  }

  /** Export Google-native files (Docs/Sheets/Slides) to a downloadable format.
   *  - Sheets  → text/csv
   *  - Docs    → text/plain (or text/markdown if supported)
   *  - Slides  → application/pdf */
  async exportFile(fileId: string, mimeType: string): Promise<{ base64: string; size: number }> {
    const url = new URL(`${DRIVE_BASE}/files/${fileId}/export`);
    url.searchParams.set('mimeType', mimeType);
    url.searchParams.set('key', this.apiKey);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive ${res.status}: ${body || res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { base64: buf.toString('base64'), size: buf.length };
  }
}
