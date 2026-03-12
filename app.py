import os
from flask import Flask, render_template, request, jsonify
from analyzer import ContractAnalyzer
from orchestrator import ContractOrchestrator

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "uploads")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB max

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

analyzer = ContractAnalyzer()
orchestrator = ContractOrchestrator()

ALLOWED_EXTENSIONS = {"txt", "pdf", "docx"}


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def extract_text_from_request():
    """Extract contract text from request (file upload or text input)."""
    if "contract" in request.files:
        file = request.files["contract"]
        if file.filename == "":
            return None, ("No file selected", 400)
        if not allowed_file(file.filename):
            return None, ("File type not allowed. Use .txt, .pdf, or .docx", 400)
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], file.filename)
        file.save(filepath)
        text = analyzer.extract_text(filepath)
        os.remove(filepath)
        return text, None
    elif request.is_json and request.json.get("text"):
        return request.json["text"], None
    elif request.form.get("text"):
        return request.form["text"], None
    return None, ("No contract text or file provided", 400)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/analyze", methods=["POST"])
def analyze():
    text, error = extract_text_from_request()
    if error:
        return jsonify({"error": error[0]}), error[1]
    if not text or not text.strip():
        return jsonify({"error": "Could not extract text from the provided input"}), 400

    result = analyzer.analyze(text)
    return jsonify(result)


@app.route("/analyze/orchestrated", methods=["POST"])
def analyze_orchestrated():
    """Run multi-agent orchestrated analysis with cross-validation and executive review."""
    text, error = extract_text_from_request()
    if error:
        return jsonify({"error": error[0]}), error[1]
    if not text or not text.strip():
        return jsonify({"error": "Could not extract text from the provided input"}), 400

    result = orchestrator.analyze(text)
    return jsonify(result)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
