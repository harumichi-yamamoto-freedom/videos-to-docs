// e2e 用の差し替え。本物は firebase を import してアプリの設定 (env) を要求するので、
// ハーネスでは console に出すだけにする。
export const reportHandledError = (draft: unknown): void => {
  console.log('[repro] reportHandledError', JSON.stringify(draft));
};
