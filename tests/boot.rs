//! The app boots and paints.
//!
//! This is the check that the fork's bindings work: the same widgets the app shows are built
//! headlessly, and the frame is read back. A gap in the Rust API shows up here as a failing test
//! instead of in somebody else's build.

use opentui::testing::TestApp;

#[test]
fn the_app_boots_and_paints() {
    let app = TestApp::new(40, 10);
    tfm::build(&app);

    let frame = app.render();
    assert!(frame.text().contains("tfm"), "the title is on the frame:\n{}", frame.text());
    assert!(frame.text().contains("rust port"), "the hint is on the frame:\n{}", frame.text());
}
