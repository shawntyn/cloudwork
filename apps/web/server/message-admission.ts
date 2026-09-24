type MessageStatus = { state: 'accepted' | 'pending' | 'absent' };

/** An accepted retry still reaches the manager so it can compare the prompt. */
export async function submitMessageWithRateLimit(
  requestId: string,
  status: () => Promise<MessageStatus>,
  limit: () => Promise<void>,
  submit: () => Promise<unknown>,
) {
  const accepted = async () => {
    try { return (await status()).state === 'accepted'; }
    catch { return false; }
  };
  if (await accepted()) return submit();
  try { await limit(); }
  catch (error) {
    // The receipt may have committed after the first status lookup.
    if (await accepted()) return submit();
    throw error;
  }
  return submit();
}
