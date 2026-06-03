/** Log chi tiết từng lô LLM / map — bật bằng AI_VERBOSE_LOG=1 */
export function aiVerboseLog(...args: unknown[]): void {
  if (process.env.AI_VERBOSE_LOG === "1") {
    console.log(...args);
  }
}

/** Một dòng tóm tắt mỗi giai đoạn (luôn bật trừ khi AI_LOG=0) */
export function aiInfoLog(...args: unknown[]): void {
  if (process.env.AI_LOG === "0") return;
  console.log(...args);
}
