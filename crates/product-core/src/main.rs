fn main() {
    if let Err(error) = superwagie_product_core::transport::run_stdio() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
