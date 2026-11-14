//! The port starts here.
//!
//! `tfm` is a terminal file manager, written in Rust on the OpenTUI fork. The fork's crates keep
//! upstream's names, so the API is `opentui::…` and only the dependency's source says fork.

use opentui::prelude::*;

/// Builds the app's root and returns it.
///
/// The app and the tests share this, so a test drives the same widgets the app shows.
pub fn build(app: &App) {
    let theme = app.theme();
    app.root().justify(Justify::Center).align_items(Align::Center);

    let title = Text::new(app, "tfm").fg(theme.accent).bold();
    let hint = Text::new(app, "the rust port starts here").fg(theme.muted);

    let card = View::new(app)
        .border(BorderStyle::Rounded)
        .border_color(theme.accent)
        .padding_x(4)
        .padding_y(1)
        .gap(1)
        .width(30)
        .child(&title)
        .child(&hint);
    app.root().add(&card);

    app.on_key(|cx, key| {
        if key.matches("q") {
            cx.quit();
        }
    });
}
