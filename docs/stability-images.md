# Stability AI keyframes

Stability's hosted video API was retired July 24, 2025. Its credits can generate still images; the app does not advertise Stability as a video backend. AI motion requires a separate ComfyUI GPU worker or video provider.

- Save `STABILITY_API_KEY` in the Render service's private environment settings.
- Adding the key alone does **not** enable spending. `IMAGE_GENERATION_PROVIDER=none` remains the default.
- After authorizing an image-generation budget, select `IMAGE_GENERATION_PROVIDER=stability` to use Stable Image Core in the existing Initial Frames stage. Core costs 3 credits per successful generation at the current published rate. Retries and regenerations can incur additional successful-generation charges; budget accordingly.
- The adapter supports text-to-image for the documented ratios. It does not claim reference-image editing, character-identity guarantees or video generation. Approve consistent character keyframes before generating motion.

Operators can POST `/api/internal/providers/stability` with the existing `x-job-drain-secret` header to verify configuration, authentication and credit balance. This calls only `GET https://api.stability.ai/v1/user/balance`, not a generation endpoint. The response is not cached; the API key is never returned. Unauthorized requests are rejected before contacting Stability.

Core generation uses multipart requests with separate positive/negative prompts and PNG output. Provider errors, filtered images, wrong signatures and oversized images are rejected. The API key is never stored in provider request snapshots or returned media metadata. Calls use a fixed official API host and do not follow authenticated redirects.

Official references: [Core API](https://docs.stability.ai/api-reference/generate/stable-image-core), [account balance](https://docs.stability.ai/api-reference/user/account-balance), [pricing](https://docs.stability.ai/pricing), [video retirement](https://kb.stability.ai/knowledge-base/how-to-access-stable-video-diffusion).
