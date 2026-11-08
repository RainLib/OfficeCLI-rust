/** Keep coordinated recovery below the sidecar's frame limit, leaving space
 * for the room name and sync framing. This is not update fragmentation. */
export const collaborationMaxFrameBytes=1024*1024
export const wordRecoveryUpdateLimit=collaborationMaxFrameBytes-8192
