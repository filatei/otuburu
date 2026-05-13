fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(false) // clients are in Go; no Rust client needed
        .compile_protos(&["proto/engine.proto"], &["proto"])?;
    Ok(())
}
