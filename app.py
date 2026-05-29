import os

from flask import Flask, render_template, request, jsonify
from werkzeug.utils import secure_filename

from analyzer import ContractAnalyzer

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "uploads")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB max

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

analyzer = ContractAnalyzer()

ALLOWED_EXTENSIONS = {"txt", "pdf", "docx"}


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/analyze", methods=["POST"])
def analyze():
    if "contract" in request.files:
        file = request.files["contract"]
        if file.filename == "":
            return jsonify({"error": "No file selected"}), 400
        if not allowed_file(file.filename):
            return jsonify({"error": "File type not allowed. Use .txt, .pdf, or .docx"}), 400
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], secure_filename(file.filename))
        file.save(filepath)
        text = analyzer.extract_text(filepath)
        os.remove(filepath)
    elif request.is_json and request.json.get("text"):
        text = request.json["text"]
    elif request.form.get("text"):
        text = request.form["text"]
    else:
        return jsonify({"error": "No contract text or file provided"}), 400

    if not text or not text.strip():
        return jsonify({"error": "Could not extract text from the provided input"}), 400

    result = analyzer.analyze(text)
    return jsonify(result)


if __name__ == "__main__":
    app.run(debug=os.environ.get('FLASK_DEBUG', 'false').lower() == 'true', port=5000)
