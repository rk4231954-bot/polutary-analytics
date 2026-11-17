import poultry_api


def test_package_is_importable() -> None:
    assert poultry_api.__version__ == "0.1.0"
