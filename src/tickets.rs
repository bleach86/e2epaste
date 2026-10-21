//! One-time tickets for downloading an attachment. Opening a paste (which
//! counts a view) hands out one, so attachments can't be downloaded without
//! using a view. Kept in memory: a restart only means opening the paste again.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::paste_db::ATTACHMENT_WINDOW;
use crate::secrets;

/// How long a ticket can be used: as long as a used-up paste's attachment is
/// kept for downloading.
const TICKET_LIFETIME: Duration = ATTACHMENT_WINDOW;

#[derive(Default)]
pub struct DownloadTickets {
    /// Ticket -> (paste ID, when it was issued).
    tickets: Mutex<HashMap<String, (String, Instant)>>,
}

impl DownloadTickets {
    pub fn issue(&self, paste_id: &str) -> String {
        let ticket = secrets::new_token();
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        tickets.insert(ticket.clone(), (paste_id.to_string(), Instant::now()));
        ticket
    }

    /// Whether the ticket was issued for `paste_id` and hasn't expired. It
    /// can be used more than once, so a viewer can download the attachment
    /// again; a used-up paste is deleted after its first download anyway.
    pub fn is_valid(&self, ticket: &str, paste_id: &str) -> bool {
        let tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        tickets
            .get(ticket)
            .is_some_and(|(id, issued)| id == paste_id && issued.elapsed() < TICKET_LIFETIME)
    }

    /// Forgets expired tickets.
    pub fn prune(&self) {
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        tickets.retain(|_, (_, issued)| issued.elapsed() < TICKET_LIFETIME);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickets_only_work_for_their_paste() {
        let tickets = DownloadTickets::default();
        let ticket = tickets.issue("pasteAAA");
        assert!(!tickets.is_valid(&ticket, "pasteBBB"));
        assert!(!tickets.is_valid("made-up", "pasteAAA"));
        assert!(tickets.is_valid(&ticket, "pasteAAA"));
    }

    #[test]
    fn tickets_expire() {
        let tickets = DownloadTickets::default();
        let ticket = tickets.issue("pasteAAA");
        tickets.tickets.lock().unwrap().get_mut(&ticket).unwrap().1 -= TICKET_LIFETIME;
        assert!(!tickets.is_valid(&ticket, "pasteAAA"));
        tickets.prune();
        assert!(tickets.tickets.lock().unwrap().is_empty());
    }
}
