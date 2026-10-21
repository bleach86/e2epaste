//! e2ep: a client for e2ePaste. Pastes are encrypted and decrypted on this
//! machine, in the same format the site's pages use; the server only ever
//! gets ciphertext, and the key stays in the link's #fragment.

pub mod api;
pub mod crypto;
pub mod error;
pub mod link;
pub mod ops;
