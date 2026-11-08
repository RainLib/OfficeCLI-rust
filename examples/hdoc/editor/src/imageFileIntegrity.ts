/** Bind a stage acknowledgement to the actual file selected by the user. */
export async function imageFileHash(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes)))].map(value=>value.toString(16).padStart(2,'0')).join('')}
export function verifyImageStage(expected:string,actual:unknown){if(!/^[a-f0-9]{64}$/.test(expected)||actual!==expected)throw new Error('image-resource-integrity')}
