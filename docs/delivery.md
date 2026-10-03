# How a delivery works

[← back to the README](../README.md)

```
  admin                                        recipient
  ─────                                        ─────────
  create a case
  upload files / write notes
  create a link (a name + one or more
   e-mail addresses, typed or taken from
   an address group, each with the language
   the person is addressed in + limits)
  → link https://…/d/<token>                   opens the link
    (handed over by the administrator: in
     person, by chat, by their own e-mail —
     the application never sends it)
                                               types their e-mail address
                                               ── must be one of those on the link ──
                                               receives a 6-digit code by e-mail
                                               types the code
                                               ── one "opening" is counted ──
                                               sees the notes, downloads the files
                                               (session expires; link can be capped)
```

Design points behind that flow:

- **The link alone grants nothing.** A forwarded or intercepted URL cannot be opened
  without access to the recipient's mailbox. The address is typed rather than shown, so
  the page never reveals who the delivery was meant for.
- **A wrong address looks exactly like a right one.** The code form appears either way and
  nothing is sent unless the address matches, so the link is not an oracle for "who is
  this for".
- **The code is bound to the browser that asked for it** (a random `outletbox_flow`
  cookie). A code read out of the recipient's inbox by somebody else cannot be typed into
  a different browser.
- **One link can serve several people.** Everyone on its list opens the same URL with their
  own address and their own code; a code requested by one person never cancels another
  person's, and the hourly limit on code requests is counted per person. People can be
  added to a link, or removed from it, while the URL stays the same; removing someone ends
  their session at once.
- **Address groups are templates, not memberships.** Picking a group copies its addresses
  into the link. Editing or deleting the group later does not change who can open links
  that already exist — access is only ever granted on the link itself.
- **One opening = one accepted code.** `max_opens` caps how many times the delivery may be
  unlocked — in total, across everyone on the link; downloads inside a live session are not
  counted, and a session that was opened while an opening was still available is allowed
  to finish.
- **Every recipient has their own language.** The administrator sets it per address
  (`anna@example.com de`), with a default for the rest that starts on the language the
  panel is being read in. The code e-mail is written in it, whatever browser the code is
  later requested from. The delivery pages switch to it once the person has signed in;
  before that they use it only if everyone on the link shares one language, and follow the
  browser otherwise — the page never changes language according to the address typed,
  which would reveal whether that address was on the list. A visitor who picks a language
  in the footer keeps it.
- **The code is typed into six boxes, one digit each.** The whole code can be pasted into
  any of them, and the form is submitted as soon as the sixth digit is there. The boxes
  are ordinary inputs posting under the same name, so the page still works with
  JavaScript switched off.
- **Revoking a link, or closing the case, ends any session already open**, immediately.
- The code is **never** written to the application log, never stored in clear (scrypt, the
  same work factor as an admin password) and never repeated in the audit trail.
