#![cfg_attr(windows, windows_subsystem = "windows")]
#[path="../../src/kvm/model.rs"] mod model;
#[cfg(test)] #[path="../../src/kvm/identity.rs"] mod identity;
#[path="../../src/kvm/broker_protocol.rs"] mod broker_protocol;
#[cfg(windows)] #[path="../../src/kvm/broker_service.rs"] mod broker_service;
fn main(){#[cfg(windows)] broker_service::run();}
