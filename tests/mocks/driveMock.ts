import type { HandleMessageDeps } from "../../src/pipeline/handleMessage.js";

export interface FakeDrive {
  uploads: { clientUserId: string; orderId: string; fileName: string }[];
  ops: HandleMessageDeps["drive"];
}

export function createFakeDrive(): FakeDrive {
  const uploads: FakeDrive["uploads"] = [];
  const ops: HandleMessageDeps["drive"] = {
    async uploadClientFile(clientUserId, orderId, fileName) {
      uploads.push({ clientUserId, orderId, fileName });
      return {
        fileId: `fake-${uploads.length}`,
        webViewLink: `https://drive.example.com/fake-${uploads.length}`,
      };
    },
  };
  return { uploads, ops };
}
