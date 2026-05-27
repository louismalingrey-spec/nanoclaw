// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import.
//
// Skills add a new provider by appending one import line below.

// claude — registers ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY forwarding.
// Required on the VPS for OpenRouter routing; safe no-op on Macs that
// don't have either var in .env.
import './claude.js';
