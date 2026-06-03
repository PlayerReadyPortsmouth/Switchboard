/** Deploy buttons (customId namespace `deploy:`) may be pressed ONLY by the
 *  configured approver. Non-deploy customIds are not governed here
 *  (return true = "not my concern"). */
export function isDeployAuthorized(customId: string, userId: string, approverUserId: string): boolean {
  if (!customId.startsWith("deploy:")) return true;
  if (!approverUserId) return false;
  return userId === approverUserId;
}
