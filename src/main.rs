//! The app's entry point.

use opentui::prelude::*;

fn main() -> Result<()> {
    let app = App::new(AppOptions::default())?;
    tfm::build(&app);
    app.run()
}
